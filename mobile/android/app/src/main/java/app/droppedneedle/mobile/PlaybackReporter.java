package app.droppedneedle.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.ConnectivityManager;
import android.net.Network;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import androidx.annotation.Nullable;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.Player;
import com.getcapacitor.JSObject;
import java.io.IOException;
import java.util.UUID;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;
import okhttp3.HttpUrl;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import org.json.JSONException;

/** The native playback session owns presence, history and scrobbling for a local library track. */
@androidx.annotation.OptIn(markerClass = androidx.media3.common.util.UnstableApi.class)
final class PlaybackReporter implements Player.Listener {
    private static final long HEARTBEAT_MS = 5000;
    private static final MediaType JSON = MediaType.get("application/json");
    private final Player player;
    private final String device;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final OkHttpClient http;
    private final OfflinePlayHistory history;
    private final ConnectivityManager connectivity;
    private final BooleanSupplier connected;
    private final ConnectivityManager.NetworkCallback restored = new ConnectivityManager.NetworkCallback() {
        @Override public void onAvailable(Network network) { history.wake(); }
    };
    // Stop must arrive before the following start, including successive plays of the same track.
    private final ThreadPoolExecutor sender = new ThreadPoolExecutor(1, 1, 0, TimeUnit.SECONDS,
            new ArrayBlockingQueue<>(64), new ThreadPoolExecutor.DiscardPolicy());
    private final Runnable heartbeat = this::heartbeat;
    private boolean awaitingNetwork;
    private final Runnable endInterruptedListen = this::endInterruptedListen;
    private HttpUrl endpoint;
    private OfflinePlayHistory.Session account;
    private Runnable stopWatching;
    private boolean offlinePlay;
    private long started, historyRevision;
    private MediaItem active;
    private long lengthMs;
    private long positionMs;
    private long heardMs;
    private long playingSince = C.TIME_UNSET;

    PlaybackReporter(Context context, Player player) {
        this(context, player, new OfflinePlayHistory(context), new OkHttpClient.Builder()
                .followRedirects(false).followSslRedirects(false)
                .retryOnConnectionFailure(false).callTimeout(5, TimeUnit.SECONDS).build(), null);
    }
    PlaybackReporter(Context context, Player player, OfflinePlayHistory history, OkHttpClient http,
            @Nullable BooleanSupplier network) {
        this.player = player;
        this.history = history;
        this.http = http;
        connectivity = network == null ? context.getSystemService(ConnectivityManager.class) : null;
        connected = network == null ? () -> connectivity != null && connectivity.getActiveNetwork() != null : network;
        if (connectivity != null) connectivity.registerDefaultNetworkCallback(restored);
        SharedPreferences preferences = context.getSharedPreferences("playback", Context.MODE_PRIVATE);
        String saved = preferences.getString("device", null);
        if (saved == null) {
            saved = "android-" + UUID.randomUUID().toString().substring(0, 8);
            preferences.edit().putString("device", saved).apply();
        }
        device = saved;
        player.addListener(this);
    }

    void connect(HttpUrl api, String credential, @Nullable OfflineStore offline) {
        disconnect();
        endpoint = api;
        account = new OfflinePlayHistory.Session(api, credential, offline, connected);
        if (offline != null) stopWatching = offline.watchOfflineMode(history::wake);
        history.authorize(account);
    }
    void retryOfflineHistory() { history.wake(); }

    void disconnect() {
        if (active != null) finish(player.getCurrentPosition());
        endpoint = null;
        account = null;
        history.authorize(null);
        if (stopWatching != null) { stopWatching.run(); stopWatching = null; }
        main.removeCallbacks(heartbeat);
    }

    private void countTime() {
        if (playingSince == C.TIME_UNSET) return;
        heardMs += Math.max(0, SystemClock.elapsedRealtime() - playingSince);
        playingSince = C.TIME_UNSET;
    }

    private static Object occurrence(@Nullable MediaItem item) {
        return item == null || item.localConfiguration == null ? null : item.localConfiguration.tag;
    }

    @Override public void onPositionDiscontinuity(Player.PositionInfo oldPosition,
            Player.PositionInfo newPosition, int reason) {
        if (active == null || occurrence(active) != occurrence(oldPosition.mediaItem)) return;
        if (reason == Player.DISCONTINUITY_REASON_AUTO_TRANSITION
                || occurrence(oldPosition.mediaItem) != occurrence(newPosition.mediaItem)) {
            finish(oldPosition.positionMs);
        }
    }

    @Override public void onEvents(Player ignored, Player.Events events) {
        if (endpoint == null) return;
        MediaItem item = player.getCurrentMediaItem();
        boolean ended = player.getPlaybackState() == Player.STATE_ENDED;
        if (active != null && occurrence(active) == occurrence(item) && player.getPlayWhenReady()
                && StreamRecovery.transportError(player.getPlayerError())) {
            // A route change can leave the same listen briefly idle. Never count the gap as
            // listening time or report a second start when the retained track resumes.
            countTime();
            main.removeCallbacks(heartbeat);
            if (!awaitingNetwork) {
                awaitingNetwork = true;
                main.postDelayed(endInterruptedListen, StreamRecovery.WAIT_MS);
            }
            return;
        }
        cancelInterruptedListen();
        if (active != null && (occurrence(active) != occurrence(item) || ended
                || player.getPlaybackState() == Player.STATE_IDLE || player.getPlayerError() != null)) {
            finish(occurrence(active) == occurrence(item) ? player.getCurrentPosition() : positionMs);
        }
        if (item == null || ended || player.getPlayerError() != null) return;
        if (active == null) {
            // Preparing and seeking a paused item must not announce a fresh listen.
            if (!player.isPlaying()) return;
            active = item;
            // Pin one reporting path to this audible occurrence, including later offline-mode changes.
            offlinePlay = !account.online.getAsBoolean();
            historyRevision = account.offline == null ? -1 : account.offline.historyRevision();
            started = System.currentTimeMillis() / 1000;
            lengthMs = Math.max(0, player.getDuration());
            positionMs = player.getCurrentPosition();
            heardMs = 0;
            playingSince = SystemClock.elapsedRealtime();
            if (!offlinePlay) send("start", body());
        } else {
            countTime();
            positionMs = player.getCurrentPosition();
            if (player.getDuration() > 0) lengthMs = player.getDuration();
            if (player.isPlaying()) playingSince = SystemClock.elapsedRealtime();
            if (!offlinePlay && (events.contains(Player.EVENT_IS_PLAYING_CHANGED)
                    || events.contains(Player.EVENT_POSITION_DISCONTINUITY))) progress();
        }
        main.removeCallbacks(heartbeat);
        if (player.isPlaying()) main.postDelayed(heartbeat, HEARTBEAT_MS);
    }

    private void endInterruptedListen() {
        if (active != null && !player.isPlaying() && StreamRecovery.transportError(player.getPlayerError()))
            finish(player.getCurrentPosition());
    }

    private void cancelInterruptedListen() {
        if (!awaitingNetwork) return;
        awaitingNetwork = false;
        main.removeCallbacks(endInterruptedListen);
    }

    private void heartbeat() {
        if (active == null || !player.isPlaying()) return;
        positionMs = player.getCurrentPosition();
        if (player.getDuration() > 0) lengthMs = player.getDuration();
        if (!offlinePlay && sender.getQueue().isEmpty()) progress();
        main.postDelayed(heartbeat, HEARTBEAT_MS);
    }

    private void progress() {
        JSObject body = body();
        body.put("is_paused", !player.isPlaying());
        send("progress", body);
    }

    private void finish(long position) {
        cancelInterruptedListen();
        countTime();
        positionMs = position;
        if (offlinePlay) {
            if (OfflineScrobble.qualifies(lengthMs, heardMs, positionMs)) {
                try {
                    history.record(account, OfflineScrobble.play(active.mediaId, text(active.mediaMetadata.title),
                            text(active.mediaMetadata.artist), text(active.mediaMetadata.albumTitle), lengthMs, started),
                            historyRevision);
                } catch (JSONException invalid) { Log.w("DNPlayback", "Offline play metadata was unavailable."); }
            }
        } else {
            JSObject body = body();
            body.put("ignore_scrobble", !OfflineScrobble.heardEnough(lengthMs, heardMs));
            send("stop", body);
        }
        active = null;
        main.removeCallbacks(heartbeat);
    }
    private static String text(@Nullable CharSequence value) { return value == null ? "" : value.toString(); }

    private JSObject body() {
        JSObject body = new JSObject();
        body.put("track_id", active.mediaId);
        body.put("source", "local");
        body.put("device", device);
        body.put("position_ms", Math.max(0, positionMs));
        if (lengthMs > 0) body.put("duration_ms", lengthMs);
        return body;
    }

    private void send(String operation, JSObject body) {
        // Capture both the destination and the session. A queued report never adopts a later login.
        OfflinePlayHistory.Session owner = account;
        if (!owner.online.getAsBoolean()) return;
        Request request = new Request.Builder().url(endpoint.newBuilder().addPathSegment(operation).build())
                .header("Authorization", "Bearer " + owner.token)
                .post(RequestBody.create(JSON, body.toString())).build();
        sender.execute(() -> {
            if (!owner.online.getAsBoolean()) return;
            try (Response response = http.newCall(request).execute()) {
                if (!response.isSuccessful()) Log.w("DNPlayback", operation + " report returned " + response.code());
            } catch (IOException e) {
                Log.w("DNPlayback", operation + " report was unavailable");
            }
        });
    }

    void close() {
        disconnect();
        if (connectivity != null) connectivity.unregisterNetworkCallback(restored);
        history.close();
        player.removeListener(this);
        sender.shutdown();
    }
}
