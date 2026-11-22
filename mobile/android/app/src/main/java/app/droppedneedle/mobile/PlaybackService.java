package app.droppedneedle.mobile;

import android.app.ForegroundServiceStartNotAllowedException;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.Uri;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.media.AudioManager;
import android.os.Binder;
import android.os.Build;
import android.os.IBinder;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import androidx.annotation.Nullable;
import androidx.annotation.RequiresApi;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.Player;
import androidx.media3.datasource.DataSource;
import androidx.media3.datasource.okhttp.OkHttpDataSource;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.session.DefaultMediaNotificationProvider;
import androidx.media3.session.MediaSession;
import androidx.media3.session.MediaLibraryService;
import androidx.media3.session.MediaLibraryService.MediaLibrarySession;
import androidx.media3.session.MediaStyleNotificationHelper;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.google.common.util.concurrent.Futures;
import com.google.common.util.concurrent.ListenableFuture;
import com.google.common.util.concurrent.SettableFuture;
import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CompletableFuture;
import java.util.UUID;
import javax.crypto.SecretKey;
import okhttp3.HttpUrl;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import org.json.JSONException;
import org.json.JSONObject;

@androidx.annotation.OptIn(markerClass = androidx.media3.common.util.UnstableApi.class)
public final class PlaybackService extends MediaLibraryService {
    static final String LOCAL_BIND = "app.droppedneedle.mobile.LOCAL_PLAYER";
    final class LocalBinder extends Binder {
        PlaybackService service() { return PlaybackService.this; }
    }

    static final class Access implements OfflineDataSource.Library {
        final String artworkScope = UUID.randomUUID().toString();
        final HttpUrl base;
        final String apiPath;
        final String token;
        final String userId;
        final OfflineStore offline;
        final StreamProfiles profiles;
        final ConcurrentHashMap<String, JSONObject> metadata = new ConcurrentHashMap<>();

        Access(Context context, String address, String token, @Nullable String userId) {
            offline = OfflineStore.forUser(context, address, userId);
            profiles = new StreamProfiles(context, address, userId, () -> StreamProfiles.active(context));
            base = HttpUrl.parse(address);
            if (base == null || !base.isHttps() || !base.username().isEmpty()
                    || !base.password().isEmpty() || token == null || token.isEmpty()) {
                throw new IllegalArgumentException("Connect to DroppedNeedle over HTTPS.");
            }
            this.token = token;
            this.userId = userId;
            apiPath = base.encodedPath().replaceAll("/+$", "") + "/api/v3/";
        }

        @Override public OfflineStore store() { return offline; }
        @Override public JSONObject metadata(String id) { return metadata.get(id); }

        boolean allowsOnlineMedia() { return offline == null || !offline.offlineOnly(); }

        boolean permits(HttpUrl url, String path) {
            return url != null && url.isHttps() && url.host().equals(base.host())
                    && url.port() == base.port() && url.username().isEmpty() && url.password().isEmpty()
                    && url.encodedPath().startsWith(apiPath + path);
        }
    }

    private final LocalBinder binder = new LocalBinder();
    private volatile Access access;
    private RoutedPlayer player;
    private MediaLibrarySession session;
    private CarSession car;
    private Object pendingCarTrack;
    private final Runnable stopEmptyExternalPlay = () -> {
        if (player.getMediaItemCount() == 0 && !car.isSelecting()) stopForeground(STOP_FOREGROUND_REMOVE);
    };
    private PlaybackReporter reporter;
    private PlaybackEqualizer equalizer;
    private PlaybackSound sound;
    private PlaybackFades fades;
    private PlaybackSleepTimer sleep;
    private final TrackWaveform waveforms = new TrackWaveform();
    private final QueueReadAhead readAhead = new QueueReadAhead();
    private Runnable stopReadAheadWatch;
    private OkHttpClient playbackHttp;
    private ExoPlayer localPlayback;
    private ConversionSource audioSource;
    private Object castOccurrence;
    private java.util.concurrent.atomic.AtomicReference<JSObject> castDelivery;
    private Runnable stopFadeProfileWatch, stopFadeOfflineWatch;
    private ConnectivityManager connectivity;
    private StreamProfiles.Path playbackNetwork;
    private final ConnectivityManager.NetworkCallback playbackConnectivity = new ConnectivityManager.NetworkCallback() {
        @Override public void onCapabilitiesChanged(Network network, NetworkCapabilities capabilities) { networkChanged(); }
        @Override public void onLost(Network network) { networkChanged(); }
        private void networkChanged() {
            main.post(() -> {
                StreamProfiles.Path now = StreamProfiles.active(PlaybackService.this);
                updateReadAhead();
                if (playbackNetwork != now) {
                    playbackNetwork = now;
                    if (now == StreamProfiles.Path.OFFLINE && radio != null) {
                        cancelRadio();
                        radioProblem = "Go online to continue with similar music.";
                    }
                    fades.sourceChanged();
                }
            });
        }
    };
    private LibraryQueuePager pager;
    private boolean changingWindow, repeatLibrary, wasPlaying;
    private SavedQueue saved;
    private final QueueOrder order = new QueueOrder();
    private JSONObject previousQueue;
    private SimilarMusic radio;
    private org.json.JSONArray heard = new org.json.JSONArray();
    private boolean autoplay;
    private String radioProblem;
    private SecretKey queueKey;
    private String revision;
    // Separate from the persisted queue revision, including before a queue has a storage key.
    private String queueVersion = UUID.randomUUID().toString();
    private long generation;
    private SettableFuture<MediaSession.MediaItemsWithStartPosition> headsetPlay;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Runnable checkpoint = this::checkpoint;

    private void checkpoint() {
        save(false);
        main.removeCallbacks(checkpoint);
        if (player.isPlaying()) main.postDelayed(checkpoint, 5000);
    }

    private void save(boolean includeTracks) {
        if (includeTracks) queueVersion = UUID.randomUUID().toString();
        if (changingWindow || queueKey == null || player.getMediaItemCount() == 0) return;
        if (includeTracks) revision = UUID.randomUUID().toString();
        if (revision == null) return;
        JSObject state = archive(includeTracks);
        if (includeTracks && previousQueue != null) state.put("previousQueue", previousQueue);
        saved.write(queueKey, state, includeTracks);
    }

    private JSObject archive(boolean includeTracks) {
        JSObject state = new JSObject();
        state.put("revision", revision == null ? UUID.randomUUID().toString() : revision);
        if (access != null && access.userId != null) state.put("userId", access.userId);
        state.put("index", player.getCurrentMediaItemIndex());
        state.put("position", Math.max(0, player.getCurrentPosition()));
        state.put("repeat", repeatMode());
        consumePriority();
        state.put("upNext", order.pending(player));
        if (pager.attached()) {
            state.put("continuation", pager.saved());
            state.put("libraryExtras", order.extraIndices(player));
        }
        if (includeTracks) {
            state.put("tracks", queueTracks());
            if (order.shuffled()) state.put("shuffleOrder", order.save(player));
            if (heard.length()>0) state.put("heard", heard);
        }
        state.put("playing", showsPauseControl() || pager.waiting() || radio != null);
        return state;
    }

    @Override public void onCreate() {
        super.onCreate();
        OkHttpClient http = new OkHttpClient.Builder()
                .followRedirects(false).followSslRedirects(false)
                .addInterceptor(chain -> {
                    Request request = chain.request();
                    Access current = access;
                    String authorization = request.header("Authorization");
                    if (current == null || !current.permits(request.url(), "") ||
                            (authorization != null && !authorization.equals("Bearer " + current.token))) {
                        throw new IOException("Invalid DroppedNeedle media address.");
                    }
                    return chain.proceed(request.newBuilder()
                            .header("Authorization", "Bearer " + current.token).build());
                }).addNetworkInterceptor(chain -> {
                    Access mediaOwner = chain.request().tag(Access.class);
                    if (mediaOwner != null && (mediaOwner != access || !mediaOwner.allowsOnlineMedia()))
                        throw new IOException("Online media is unavailable.");
                    return chain.proceed(chain.request());
                }).build();
        playbackHttp = http;
        OkHttpDataSource.Factory source = new OkHttpDataSource.Factory(http);
        audioSource = new ConversionSource(timeline -> {
            Access current = access;
            DataSource.Factory stream = current == null ? source : new OkHttpDataSource.Factory(http)
                    .setDefaultRequestProperties(Collections.singletonMap("Authorization", "Bearer " + current.token));
            return new OfflineDataSource(current, stream, timeline, current == null ? null : current.profiles.track());
        });
        sound = new PlaybackSound(this);
        equalizer = new PlaybackEqualizer(this);
        ExoPlayer local = new ExoPlayer.Builder(this, PlaybackSound.renderers(this, sound.primary, track -> main.post(() -> equalizer.monitor(track))))
                .setMediaSourceFactory(audioSource)
                .setAudioAttributes(AudioAttributes.DEFAULT, true)
                .setHandleAudioBecomingNoisy(true)
                .setWakeMode(C.WAKE_MODE_LOCAL)
                .build();
        localPlayback = local;
        player = new RoutedPlayer(this, local, item -> {
            Access owner = access;
            castOccurrence = trackIdentity(item);
            java.util.concurrent.atomic.AtomicReference<JSObject> observed = new java.util.concurrent.atomic.AtomicReference<>();
            castDelivery = observed;
            Uri canonical = item.localConfiguration.uri;
            String url = canonical.toString();
            StreamProfiles.Selection stream = owner == null ? null : owner.profiles.track();
            return (range, head) -> {
                Access current = access;
                if (owner == null || current == null || !owner.token.equals(current.token)
                        || !owner.base.equals(current.base) || !owner.permits(HttpUrl.parse(url), "stream/local/")) {
                    throw new IOException("The playback session changed.");
                }
                if (owner.offline != null) {
                    File file = owner.offline.playable(url);
                    if (file != null) {
                        CastRelay.Media media = CastRelay.fromFile(file, CastRelay.audioType(file)).open(range, head);
                        if (!head && media.status >= 200 && media.status < 300) {
                            JSObject delivery = new JSObject();
                            delivery.put("source", owner.offline.playbackOrigin(url, file));
                            delivery.put("mime", media.mime);
                            observed.set(delivery);
                        }
                        return media;
                    }
                    if (owner.offline.offlineOnly()) throw new IOException("This song is not saved on this device.");
                }
                Uri selected = stream.forRequest(canonical);
                CastRelay.Media media = CastRelay.fromDn(http, selected.toString(), owner.token).open(range, head);
                if (media.status == 409 && ConversionSource.requested(selected)) {
                    media.close();
                    selected = ConversionSource.original(canonical);
                    media = CastRelay.fromDn(http, selected.toString(), owner.token).open(range, head);
                }
                if (media.status >= 200 && media.status < 300) {
                    stream.opened(selected);
                    if (!head) {
                        JSObject delivery = StreamProfiles.networkDelivery(stream, selected, media.acceptRanges, false);
                        delivery.put("mime", media.mime);
                        observed.set(delivery);
                    }
                }
                return media;
            };
        });
        sleep = new PlaybackSleepTimer(new PlaybackSleepTimer.Host() {
            @Override public long elapsed() { return SystemClock.elapsedRealtime(); }
            @Override public void schedule(Runnable task, long ms) { main.postDelayed(task, ms); }
            @Override public void unschedule(Runnable task) { main.removeCallbacks(task); }
            @Override public void pause() {
                wasPlaying = false;
                cancelRadio();
                pager.cancelAdvance();
                player.pause();
            }
            @Override public void pauseAtEnd(boolean enabled) {
                local.setPauseAtEndOfMediaItems(enabled);
                player.pauseRemoteAtEnd(enabled);
                if (fades != null) fades.refresh();
            }
            @Override public Object playingTrack() {
                return showsPauseControl() ? trackIdentity(player.getCurrentMediaItem()) : null;
            }
        });
        player.remoteAdvance = item -> sleep.changedTrack(trackIdentity(item), true);
        pager = new LibraryQueuePager(new LibraryQueuePager.Host() {
            @Override public JSArray tracks() { return queueTracks(true); }
            @Override public int index() { return player.getCurrentMediaItemIndex(); }
            @Override public int count() { return player.getMediaItemCount(); }
            @Override public boolean active() { return showsPauseControl(); }
            @Override public boolean offlineOnly() { return access == null || access.offline != null && access.offline.offlineOnly(); }
            @Override public void apply(LibraryWindow.Batch batch, boolean restart, boolean resume) throws JSONException {
                applyPage(batch, restart, resume);
            }
        }, new LibraryQueuePager.Dispatch() {
            @Override public void post(Runnable task) { main.post(task); }
            @Override public void later(Runnable task, long delay) { main.postDelayed(task, delay); }
            @Override public void cancel(Runnable task) { main.removeCallbacks(task); }
        }, http);
        fades = new PlaybackFades(this, local, () -> SmartFadeAudio.library(access, http),
                () -> player.destination().isEmpty() && !sleep.active(), sound);
        connectivity = getSystemService(ConnectivityManager.class);
        playbackNetwork = StreamProfiles.active(this);
        if (connectivity != null) connectivity.registerDefaultNetworkCallback(playbackConnectivity);
        local.setPlaybackSpeed(sound.speed());
        int audioSession = local.getAudioSessionId();
        if (audioSession <= 0) {
            try {
                AudioManager audio = (AudioManager) getSystemService(AUDIO_SERVICE);
                int allocated = audio == null ? 0 : audio.generateAudioSessionId();
                if (allocated > 0) {
                    local.setAudioSessionId(allocated);
                    audioSession = allocated;
                }
            } catch (RuntimeException ignored) {
                // Playback can still use the framework-selected session when one becomes available.
            }
        }
        equalizer.setSession(audioSession);
        saved = new SavedQueue(this);
        reporter = new PlaybackReporter(this, player);
        local.addListener(new Player.Listener() {
            @Override public void onPlayWhenReadyChanged(boolean ready, int reason) {
                if (!ready && radio != null) cancelRadio();
                if (!ready && reason == Player.PLAY_WHEN_READY_CHANGE_REASON_END_OF_MEDIA_ITEM && sleep.afterTrack()) {
                    wasPlaying = false;
                    pager.cancelAdvance();
                    sleep.finishedTrack();
                }
            }
            @Override public void onMediaItemTransition(@Nullable MediaItem item, int reason) {
                sound.primary.factor = sound.factor(item);
                sleep.changedTrack(trackIdentity(item), reason == Player.MEDIA_ITEM_TRANSITION_REASON_AUTO
                        || reason == Player.MEDIA_ITEM_TRANSITION_REASON_REPEAT || fades.automaticAdvance(item));
            }
            @Override public void onTracksChanged(androidx.media3.common.Tracks tracks) {
                sound.remember(local.getCurrentMediaItem(),tracks);
                sound.primary.factor = sound.factor(local.getCurrentMediaItem());
                fades.gainChanged();
            }
            @Override public void onAudioSessionIdChanged(int id) { equalizer.setSession(id); }
        });
        player.addListener(new Player.Listener() {
            @Override public void onEvents(Player source, Player.Events events) {
                if (events.containsAny(Player.EVENT_IS_PLAYING_CHANGED, Player.EVENT_TIMELINE_CHANGED,
                        Player.EVENT_MEDIA_ITEM_TRANSITION, Player.EVENT_REPEAT_MODE_CHANGED,
                        Player.EVENT_SHUFFLE_MODE_ENABLED_CHANGED)) updateReadAhead();
                sleep.check();
                if (events.contains(Player.EVENT_TIMELINE_CHANGED)) queueVersion = UUID.randomUUID().toString();
                if (!changingWindow && events.contains(Player.EVENT_MEDIA_ITEM_TRANSITION)) consumePriority();
                if (pendingCarTrack != null && events.contains(Player.EVENT_TIMELINE_CHANGED)
                        && source.getMediaItemCount() > 0 && pendingCarTrack == trackIdentity(source.getMediaItemAt(0))) {
                    pendingCarTrack = null;
                    save(true);
                }
                if (events.containsAny(Player.EVENT_MEDIA_ITEM_TRANSITION, Player.EVENT_PLAY_WHEN_READY_CHANGED,
                        Player.EVENT_PLAYBACK_STATE_CHANGED, Player.EVENT_MEDIA_METADATA_CHANGED))
                    PlayerWidget.render(PlaybackService.this, source);
                if (radio != null && (events.containsAny(Player.EVENT_POSITION_DISCONTINUITY,Player.EVENT_REPEAT_MODE_CHANGED)
                        || source.getPlaybackSuppressionReason() != Player.PLAYBACK_SUPPRESSION_REASON_NONE)) cancelRadio();
                boolean ended = source.getPlaybackState() == Player.STATE_ENDED;
                boolean sleepBoundary = sleep.afterTrack() && ended;
                if (ended && (sleepBoundary || !autoplay && (!pager.attached() || !pager.hasNext() && !repeatLibrary))) sleep.finishedTrack();
                if (!changingWindow) {
                    if (pager.attached() && events.contains(Player.EVENT_REPEAT_MODE_CHANGED) && source.getRepeatMode() == Player.REPEAT_MODE_ALL)
                        setRepeat(Player.REPEAT_MODE_ALL);
                    if (ended && wasPlaying) {
                        wasPlaying = false;
                        if (!sleepBoundary && pager.attached() && (pager.hasNext() || repeatLibrary)) pager.end(false);
                        else if (!sleepBoundary && autoplay && source.getPlayWhenReady()) startRadio();
                    } else if (!ended) {
                        wasPlaying = showsPauseControl();
                        if (wasPlaying && pager.attached()) pager.load(false);
                    }
                }
                if (events.containsAny(Player.EVENT_IS_PLAYING_CHANGED, Player.EVENT_POSITION_DISCONTINUITY,
                        Player.EVENT_REPEAT_MODE_CHANGED, Player.EVENT_PLAYBACK_STATE_CHANGED)) checkpoint();
            }
        });
        car = new CarSession(this) {
            @Override public ListenableFuture<MediaSession.MediaItemsWithStartPosition> onPlaybackResumption(
                    MediaSession mediaSession, MediaSession.ControllerInfo controller) {
                return resumeHeadset(controller);
            }
        };
        session = new MediaLibrarySession.Builder(this, player, car)
                .setSessionActivity(NotificationRoute.Destination.PLAYER.pendingIntent(this))
                .setBitmapLoader(new PlaybackArtwork(() -> access, http))
                .build();
        addSession(session);
    }

    @Nullable @Override public IBinder onBind(@Nullable Intent intent) {
        if (intent != null && LOCAL_BIND.equals(intent.getAction())) return binder;
        return super.onBind(intent);
    }

    @Override public int onStartCommand(@Nullable Intent intent, int flags, int startId) {
        // Media3 starts its own service when posting a playback notification. A quick stop can
        // deliver that actionless start to a replacement instance with no player to promote.
        if (Build.VERSION.SDK_INT >= 26 && intent != null && intent.getAction() == null
                && player.getMediaItemCount() == 0) {
            if (!showStartingNotification()) {
                stopSelfResult(startId);
                return START_NOT_STICKY;
            }
            if (headsetPlay == null && !car.isSelecting()) {
                if (stopSelfResult(startId)) stopForeground(STOP_FOREGROUND_REMOVE);
                return START_NOT_STICKY;
            }
        }
        return super.onStartCommand(intent, flags, startId);
    }

    @Override public MediaLibrarySession onGetSession(MediaSession.ControllerInfo controller) { return session; }

    long carGeneration() { return generation; }
    void prepareExternalPlay() {
        if (Build.VERSION.SDK_INT < 35 || player.isPlaying() || !HeadsetAccount.unlocked(this)) return;
        // Android 15 requires foreground playback before ExoPlayer can request audio focus for a user tap.
        if (showStartingNotification()) {
            main.removeCallbacks(stopEmptyExternalPlay);
            main.postDelayed(stopEmptyExternalPlay, 15000);
        }
    }

    @RequiresApi(26)
    private boolean showStartingNotification() {
        String channel = DefaultMediaNotificationProvider.DEFAULT_CHANNEL_ID;
        NotificationManager notifications = getSystemService(NotificationManager.class);
        notifications.createNotificationChannel(new NotificationChannel(channel,
                getString(DefaultMediaNotificationProvider.DEFAULT_CHANNEL_NAME_RESOURCE_ID),
                NotificationManager.IMPORTANCE_LOW));
        Notification notice = new NotificationCompat.Builder(this, channel)
                .setSmallIcon(android.R.drawable.ic_media_play).setContentTitle(getString(R.string.app_name))
                .setOnlyAlertOnce(true).setSilent(true)
                .setStyle(new MediaStyleNotificationHelper.MediaStyle(session)).build();
        try {
            ServiceCompat.startForeground(this, DefaultMediaNotificationProvider.DEFAULT_NOTIFICATION_ID,
                    notice, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
            return true;
        } catch (IllegalStateException error) {
            // A regular background start or a controller without a user gesture may lack the allowance.
            if (Build.VERSION.SDK_INT >= 31 && error instanceof ForegroundServiceStartNotAllowedException) return false;
            throw error;
        }
    }
    MediaSession.MediaItemsWithStartPosition prepareCarQueue(HeadsetAccount login, JSArray queue, int index, long position)
            throws JSONException {
        Access next = new Access(this, login.server.toString(), login.token, login.userId);
        ArrayList<MediaItem> checked = items(next, queue);
        boolean same = access != null && access.base.equals(next.base) && access.token.equals(next.token)
                && java.util.Objects.equals(access.userId, next.userId);
        previousQueue = same && player.getMediaItemCount() > 0 ? archive(true) : null;
        heard = new org.json.JSONArray();
        generation++;
        cancelHeadset();
        cancelRadio();
        detachWindow();
        order.reset();
        sleep.changedTrack(null);
        remember(next, checked);
        attach(next);
        pendingCarTrack = trackIdentity(checked.get(0));
        return new MediaSession.MediaItemsWithStartPosition(checked, index, position);
    }

    private static ArrayList<MediaItem> items(Access access, JSArray queue) throws JSONException {
        ArrayList<MediaItem> items = new ArrayList<>();
        java.util.IdentityHashMap<JSONObject,Boolean> occurrences = new java.util.IdentityHashMap<>();
        for (int i = 0; i < queue.length(); i++) {
            JSONObject track = queue.getJSONObject(i);
            if (occurrences.put(track,true) != null || access.metadata.get(track.getString("id")) == track)
                track = new JSONObject(track.toString());
            String stream = track.getString("streamUrl");
            if (!access.permits(HttpUrl.parse(stream), "stream/local/")) {
                throw new IllegalArgumentException("Invalid DroppedNeedle stream.");
            }
            MediaMetadata.Builder metadata = new MediaMetadata.Builder()
                    .setTitle(track.getString("title")).setArtist(track.getString("artist"))
                    .setAlbumTitle(track.getString("album"));
            metadata.setArtworkUri(PlaybackArtwork.uri(access, track.getString("id")));

            items.add(new MediaItem.Builder().setMediaId(track.getString("id"))
                    .setUri(stream).setTag(track).setMediaMetadata(metadata.build()).build());
        }
        return items;
    }

    private int repeatMode() { return repeatLibrary ? Player.REPEAT_MODE_ALL : player.getRepeatMode(); }

    private void setRepeat(int mode) {
        repeatLibrary = pager.attached() && mode == Player.REPEAT_MODE_ALL;
        if (!repeatLibrary && !pager.hasNext()) pager.cancelAdvance();
        player.setRepeatMode(repeatLibrary ? Player.REPEAT_MODE_OFF : mode);
    }

    private void detachWindow() {
        int repeat = repeatMode();
        pager.detach();
        wasPlaying = false;
        setRepeat(repeat);
    }

    private static void remember(Access owner, ArrayList<MediaItem> items) {
        for (MediaItem item : items) owner.metadata.put(item.mediaId, (JSONObject) trackIdentity(item));
    }

    private void applyPage(LibraryWindow.Batch batch, boolean restart, boolean resume) throws JSONException {
        Access owner = access;
        int before = player.getMediaItemCount();
        int prefix = restart ? before : Math.max(0, player.getCurrentMediaItemIndex() - LibraryWindow.HISTORY);
        JSArray incoming = new JSArray(batch.tracks.toString());
        ArrayList<MediaItem> newItems = items(owner, incoming);
        int bytes = 2;
        java.util.HashSet<String> retained = new java.util.HashSet<>();
        for (int i = prefix; i < before; i++) {
            MediaItem item = player.getMediaItemAt(i);
            bytes += trackIdentity(item).toString().getBytes(java.nio.charset.StandardCharsets.UTF_8).length + 1;
            retained.add(item.mediaId);
        }
        bytes += incoming.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8).length;
        if (bytes > LibraryWindow.MAX_BYTES || before - prefix + incoming.length() > 300)
            throw new IllegalArgumentException("The library queue is too large.");
        changingWindow = true;
        try {
            remember(owner, newItems);
            rememberPruned(prefix);
            if (restart) order.reset();
            else {
                order.remove(player, 0, prefix);
                order.insert(newItems, null);
                if (order.shuffled()) FreshShuffle.refill(newItems);
            }
            for (MediaItem item : newItems) retained.add(item.mediaId);
            if (restart) {
                player.setMediaItems(newItems, 0, 0);
            } else {
                player.addMediaItems(newItems);
                if (prefix > 0) player.removeMediaItems(0, prefix);
            }
            owner.metadata.keySet().retainAll(retained);
            if (resume) {
                int nextIndex = restart ? 0 : before - prefix;
                sleep.changedTrack(trackIdentity(player.getMediaItemAt(nextIndex)), true);
                player.seekTo(nextIndex, 0);
                player.prepare();
                player.play();
            }
        } finally { changingWindow = false; }
        save(true);
    }

    void setQueue(String address, String token, @Nullable String userId, JSArray queue, int index,
            @Nullable String placement, @Nullable JSONObject profiles) throws JSONException {
        setQueue(address, token, userId, queue, index, placement, profiles, null);
    }

    void setQueue(String address, String token, @Nullable String userId, JSArray queue, int index,
            @Nullable String placement, @Nullable JSONObject profiles, @Nullable JSONObject continuation) throws JSONException {
        setQueue(address, token, userId, queue, index, placement, profiles, continuation, 0, true);
    }

    void setQueue(String address, String token, @Nullable String userId, JSArray queue, int index,
            @Nullable String placement, @Nullable JSONObject profiles, @Nullable JSONObject continuation,
            double positionSeconds, boolean playing) throws JSONException {
        if (!Double.isFinite(positionSeconds) || positionSeconds < 0) throw new IllegalArgumentException("Invalid playback position.");
        if (queue == null || index < 0 || index >= queue.length()) {
            throw new IllegalArgumentException("Choose a track to play.");
        }
        if (placement != null && !placement.equals("next") && !placement.equals("upNext") && !placement.equals("end"))
            throw new IllegalArgumentException("Unknown queue placement.");
        cancelHeadset();
        generation++;
        Access next = new Access(this, address, token, userId);
        next.profiles.migrate(profiles);
        boolean append = placement != null && player.getMediaItemCount() > 0;
        if (append && (access == null || !access.base.equals(next.base) || !access.token.equals(token)
                || !java.util.Objects.equals(access.userId, userId))) {
            throw new IllegalArgumentException("This queue belongs to a different session.");
        }
        Access owner = append ? access : next;
        ArrayList<MediaItem> items = items(owner, queue);
        LibraryWindow window = LibraryWindow.parse(continuation, items.size());
        if (window != null && placement != null) throw new IllegalArgumentException("Invalid initial library queue.");
        remember(owner, items);
        if (append) {
            int at = order.insertion(player, placement);
            cancelRadio();
            boolean priority = !"end".equals(placement);
            boolean resume = priority && pager.waiting() && at == player.getMediaItemCount();
            if (!priority) detachWindow();
            else if (pager.attached()) {
                if (resume) pager.cancelAdvance();
                order.markExtras(items);
            }
            order.insert(items, priority ? player.getMediaItemAt(at - 1) : null);
            if (priority) order.mark(items);
            player.addMediaItems(at, items);
            if (resume) {
                sleep.changedTrack(trackIdentity(items.get(0)), true);
                player.seekTo(at, 0);
                player.prepare();
                player.play();
            }
            save(true);
            return;
        }
        boolean same = access != null && access.base.equals(next.base) && access.token.equals(next.token)
                && java.util.Objects.equals(access.userId, next.userId);
        previousQueue = same && player.getMediaItemCount() > 0 ? archive(true) : null;
        cancelRadio();
        order.reset();
        if (placement != null && !"end".equals(placement)) order.mark(items.subList(index + 1, items.size()));
        changingWindow = true;
        try {
            int repeat = repeatMode();
            detachWindow();
            sleep.changedTrack(null);
            attach(next);
            pager.attach(window, next.base, next.apiPath, next.token);
            setRepeat(repeat);
            player.pause();
            player.stop();
            player.setMediaItems(items, index, (long) (positionSeconds * 1000));
            if (playing) { player.prepare(); player.play(); }
        } finally { changingWindow = false; }
        wasPlaying = showsPauseControl();
        if (playing) pager.load(false);
        save(true);
    }

    private static Object trackIdentity(@Nullable MediaItem item) {
        return item == null || item.localConfiguration == null ? null : item.localConfiguration.tag;
    }

    private void attach(Access next) {
        if (access != null && (!access.base.equals(next.base) || !access.token.equals(next.token)
                || !java.util.Objects.equals(access.userId, next.userId))) {
            sleep.cancel();
            player.disconnect(true, "");
        }
        revision = null;
        queueKey = SavedQueue.key(next.base.toString(), next.token);
        authorizeReports(next);
        access = next;
        autoplay = autoplaySetting(next.base.toString(), next.userId, null);
        stopFadeWatches();
        stopFadeProfileWatch = next.profiles.watch(() -> { fades.sourceChanged(); updateReadAhead(); });
        if (next.offline != null) {
            stopReadAheadWatch = next.offline.watchReadAhead(this::updateReadAhead);
            boolean[] online = {next.allowsOnlineMedia()};
            stopFadeOfflineWatch = next.offline.watchOfflineMode(() -> {
                boolean enabled = next.allowsOnlineMedia();
                if (enabled != online[0]) { online[0] = enabled; if (!enabled) cancelRadio(); fades.sourceChanged(); }
            });
        }
        fades.sourceChanged();
    }
    private void updateReadAhead() {
        if (player != null && playbackHttp != null) readAhead.update(this, access, player, playbackHttp);
    }
    private void stopFadeWatches() {
        readAhead.cancel();
        if (stopReadAheadWatch != null) { stopReadAheadWatch.run(); stopReadAheadWatch = null; }
        if (stopFadeProfileWatch != null) { stopFadeProfileWatch.run(); stopFadeProfileWatch = null; }
        if (stopFadeOfflineWatch != null) { stopFadeOfflineWatch.run(); stopFadeOfflineWatch = null; }
    }
    private void authorizeReports(Access account) {
        reporter.connect(account.base.newBuilder().encodedPath(account.apiPath + "playback").build(),
                account.token, account.offline);
    }

    private MediaSession.MediaItemsWithStartPosition restoreArchive(Access next, JSONObject record, boolean headset)
            throws JSONException {
        if (record.has("userId") && !java.util.Objects.equals(next.userId, record.optString("userId")))
            throw new JSONException("Invalid saved queue owner.");
        JSArray queue = new JSArray(record.getJSONArray("tracks").toString());
        int index = record.getInt("index"), repeat = record.getInt("repeat");
        long position = Math.max(0, record.getLong("position"));
        String savedRevision = record.getString("revision");
        if (index < 0 || index >= queue.length() || repeat < Player.REPEAT_MODE_OFF || repeat > Player.REPEAT_MODE_ALL)
            throw new JSONException("Invalid saved cursor");
        ArrayList<MediaItem> checked = items(next, queue);
        LibraryWindow window;
        org.json.JSONArray extras = record.optJSONArray("libraryExtras");
        try { window = LibraryWindow.parse(record.optJSONObject("continuation"),
                checked.size() - (extras == null ? 0 : extras.length())); }
        catch (JSONException badCursor) { window = null; }
        if (headset && (next.offline.offlineOnly() || StreamProfiles.active(this) == StreamProfiles.Path.OFFLINE)
                && next.offline.playable(checked.get(index).localConfiguration.uri.toString()) == null)
            throw new IllegalArgumentException("The current song is unavailable offline.");
        remember(next, checked);
        attach(next);
        pager.attach(window, next.base, next.apiPath, next.token);
        setRepeat(repeat);
        order.restore(checked,record.optJSONArray("shuffleOrder"));
        order.restorePending(checked, index, record.optJSONArray("upNext"));
        order.restoreExtras(checked, window == null ? null : extras);
        heard = record.optJSONArray("heard");
        if (heard == null) heard = new org.json.JSONArray();
        previousQueue = record.optJSONObject("previousQueue");
        revision = savedRevision;
        return new MediaSession.MediaItemsWithStartPosition(checked, index, position);
    }
    private ListenableFuture<MediaSession.MediaItemsWithStartPosition> resumeHeadset(MediaSession.ControllerInfo controller) {
        if ((!controller.isTrusted() && controller.getUid() != android.os.Process.myUid())
                || !HeadsetAccount.unlocked(this) || !SavedQueue.exists(this) || headsetPlay != null)
            return Futures.immediateFailedFuture(new IllegalStateException("No eligible playback session."));
        SettableFuture<MediaSession.MediaItemsWithStartPosition> result = SettableFuture.create();
        headsetPlay = result;
        saved.forHeadset(this, (owner, record) -> {
            if (headsetPlay != result) return;
            headsetPlay = null;
            try {
                if (owner == null || record == null || !HeadsetAccount.unlocked(this) || player.getMediaItemCount() != 0)
                    throw new IllegalArgumentException("No eligible playback session.");
                Access next = new Access(this, owner.server.toString(), owner.token, owner.userId);
                result.set(restoreArchive(next, record, true));
            } catch (JSONException | IllegalArgumentException unavailable) {
                result.setException(new IllegalStateException("No eligible playback session."));
                if (player.getMediaItemCount() == 0) player.pause();
            }
        });
        return result;
    }
    private void cancelHeadset() {
        if (headsetPlay == null) return;
        SettableFuture<MediaSession.MediaItemsWithStartPosition> old = headsetPlay;
        headsetPlay = null;
        old.cancel(false);
        // Media3 1.8 forwards Play to the player after a failed resumption, even for an empty queue.
        if (player.getMediaItemCount() == 0) player.pause();
    }

    void restore(String address, String token, @Nullable String userId, @Nullable JSONObject profiles,
            Runnable complete, Runnable superseded) throws JSONException {
        cancelHeadset();
        Access next = new Access(this, address, token, userId);
        next.profiles.migrate(profiles);
        long version = ++generation;
        if (access != null) {
            if (!access.base.equals(next.base) || !access.token.equals(next.token)
                    || !java.util.Objects.equals(access.userId, next.userId)) {
                command("clear", -1, -1);
                long cleared = generation;
                saved.afterWrite(() -> {
                    if (generation == cleared) { authorizeReports(next); complete.run(); } else superseded.run();
                });
            } else {
                reporter.retryOfflineHistory();
                complete.run();
            }
            return;
        }
        saved.load(SavedQueue.key(next.base.toString(), next.token), record -> {
            if (version != generation) { superseded.run(); return; }
            // A headset request can arrive while this signed-in restore is reading the old archive.
            // Resolve it before another account's paused queue is placed on the player.
            cancelHeadset();
            if (record != null) {
                try {
                    player.pause();
                    MediaSession.MediaItemsWithStartPosition restored = restoreArchive(next, record, false);
                    player.setMediaItems(restored.mediaItems, restored.startIndex, restored.startPositionMs);
                    // An older queue gets its verified owner only through a normal signed-in app restore.
                    if (!record.has("userId") && next.userId != null) save(true);
                    // Preparing a paused restoration would fetch audio before the listener presses play.
                } catch (JSONException | IllegalArgumentException e) {
                    command("clear", -1, -1);
                    Log.w("DNPlayback", "The saved queue could not be restored.");
                }
            }
            // A fresh credential can submit saved listens even when it has no restorable player queue.
            if (access == null) authorizeReports(next);
            complete.run();
        });
    }

    JSObject soundSettings(@Nullable Double speed, @Nullable String mode) {
        JSObject result = sound.configure(speed, mode);
        if (speed != null)
            localPlayback.setPlaybackSpeed(sound.speed());
        if (mode != null) {
            sound.primary.factor = sound.factor(localPlayback.getCurrentMediaItem());
            fades.gainChanged();
        }
        return result;
    }

    PlaybackEqualizer equalizer() { return equalizer; }

    PlaybackFades fades() { return fades; }
    RoutedPlayer output() { return player; }

    void afterWrite(Runnable complete) { saved.afterWrite(complete); }

    boolean autoplaySetting(String server, String user, @Nullable Boolean enabled) {
        HttpUrl url = HttpUrl.parse(server);
        if (url == null || !url.isHttps())
            throw new IllegalArgumentException("Invalid DroppedNeedle server.");
        String key = new org.json.JSONArray(java.util.Arrays.asList(url.toString(), user)).toString();
        android.content.SharedPreferences prefs = getSharedPreferences("dn-autoplay", MODE_PRIVATE);
        if (enabled != null) {
            prefs.edit().putBoolean(key, enabled).apply();
            if (access != null && access.base.equals(url) && java.util.Objects.equals(access.userId, user)) {
                autoplay = enabled;
                if (!enabled)
                    cancelRadio();
            }
        }
        return prefs.getBoolean(key, false);
    }

    private void cancelRadio() {
        if (radio != null) radio.cancel();
        radio = null;
        radioProblem = null;
    }

    private void rememberPruned(int count) throws JSONException {
        if (count <= 0)
            return;
        // Keep a compact recent history even after the mobile queue window discards full track metadata.
        org.json.JSONArray recent = new org.json.JSONArray();
        for (int i = Math.max(0, heard.length() + count - 500); i < heard.length(); i++) recent.put(heard.get(i));
        for (int i = Math.max(0, count - 500); i < count; i++) {
            JSONObject song = (JSONObject) trackIdentity(player.getMediaItemAt(i));
            recent.put(new JSONObject()
                            .put("id", song.getString("id"))
                            .put("recordingMbid", song.opt("recordingMbid")));
        }
        heard = recent;
    }

    private void startRadio() {
        Access owner = access;
        if (radio != null || owner == null || !autoplay || repeatMode() != Player.REPEAT_MODE_OFF
                || pager.hasNext() || player.getMediaItemCount() == 0
                || player.getCurrentMediaItemIndex() != player.getMediaItemCount() - 1)
            return;
        if (!owner.allowsOnlineMedia() || playbackNetwork == StreamProfiles.Path.OFFLINE) {
            radioProblem = "Go online to continue with similar music.";
            return;
        }
        SimilarMusic request = new SimilarMusic(playbackHttp, owner);
        JSArray tracks = queueTracks();
        org.json.JSONArray recent = heard;
        Object last = trackIdentity(player.getCurrentMediaItem());
        radio = request;
        radioProblem = null;
        playbackHttp.dispatcher().executorService().execute(() -> {
            try {
                JSArray additions = request.plan(tracks, recent);
                main.post(() -> {
                    if (radio != request)
                        return;
                    radio = null;
                    if (access != owner || !owner.allowsOnlineMedia()
                            || last != trackIdentity(player.getCurrentMediaItem()))
                        return;
                    try {
                        int bytes = additions.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8).length;
                        int trim = tracks.length();
                        while (trim > 0 && tracks.length() - trim + additions.length() < 2000) {
                            bytes += tracks.getJSONObject(trim - 1)
                                             .toString()
                                             .getBytes(java.nio.charset.StandardCharsets.UTF_8)
                                             .length
                                    + 1;
                            if (bytes > LibraryWindow.MAX_BYTES)
                                break;
                            trim--;
                        }
                        if (trim == tracks.length())
                            throw new IllegalArgumentException(
                                    "The next tracks exceed the mobile queue size limit.");
                        ArrayList<MediaItem> items = items(owner, additions);
                        int start = player.getMediaItemCount() - trim;
                        changingWindow = true;
                        try {
                            detachWindow();
                            rememberPruned(trim);
                            order.remove(player, 0, trim);
                            if (trim > 0) {
                                player.removeMediaItems(0, trim);
                                java.util.HashSet<String> retained = new java.util.HashSet<>();
                                for (int i = 0; i < player.getMediaItemCount(); i++)
                                    retained.add(player.getMediaItemAt(i).mediaId);
                                owner.metadata.keySet().retainAll(retained);
                            }
                            remember(owner, items);
                            order.insert(items, null);
                            player.addMediaItems(items);
                            sleep.changedTrack(trackIdentity(items.get(0)), true);
                            player.seekTo(start, 0);
                            player.prepare();
                            player.play();
                        } finally {
                            changingWindow = false;
                        }
                        wasPlaying = showsPauseControl();
                        save(true);
                    } catch (JSONException | IllegalArgumentException failure) {
                        radioProblem = "Could not add similar tracks to the queue.";
                    }
                });
            } catch (IOException | JSONException | IllegalArgumentException failure) {
                main.post(() -> {
                    if (radio != request)
                        return;
                    radio = null;
                    // Network exceptions can contain hostnames or paths. Show only DN radio status to the
                    // listener.
                    String message = failure.getMessage();
                    radioProblem = message != null
                                    && (message.startsWith("DroppedNeedle ") || message.startsWith("This queue "))
                            ? message
                            : "Could not load similar music from DroppedNeedle.";
                });
            }
        });
    }

    private void restorePrevious() {
        if (access == null || previousQueue == null)
            return;
        JSONObject current = archive(true), old = previousQueue;
        changingWindow = true;
        try {
            MediaSession.MediaItemsWithStartPosition next = restoreArchive(access, old, false);
            previousQueue = current;
            sleep.cancel();
            player.pause();
            player.stop();
            player.setMediaItems(next.mediaItems, next.startIndex, next.startPositionMs);
            if (old.optBoolean("playing")) {
                player.prepare();
                player.play();
            }
        } catch (JSONException failure) {
            throw new IllegalArgumentException("The previous queue could not be restored.", failure);
        } finally {
            changingWindow = false;
        }
        wasPlaying = showsPauseControl();
        if (wasPlaying)
            pager.load(false);
        save(true);
    }

    CompletableFuture<Boolean> command(String action, double value, int to) {
        CompletableFuture<Boolean> persisted = CompletableFuture.completedFuture(true);
        cancelHeadset();
        sleep.check();
        int count = player.getMediaItemCount();
        int item = (int) value;
        if ("retryAutoplay".equals(action)) { startRadio(); return persisted; }
        if ("setAutoplay".equals(action)) {
            if (access != null) autoplaySetting(access.base.toString(), access.userId, value != 0);
            return persisted;
        }
        boolean waitingRadio = radio != null;
        if ("setPlaying".equals(action)) {
            if (value != 0 && (showsPauseControl() || pager.waiting() || waitingRadio)) return persisted;
            if (value == 0) { cancelRadio(); pager.cancelAdvance(); wasPlaying = false; player.pause(); return persisted; }
            action = "toggle";
        }
        cancelRadio();
        if ("restorePreviousQueue".equals(action)) { generation++; restorePrevious(); return persisted; }
        if ("clear".equals(action) || ("remove".equals(action) && count == 1 && item == 0)) {
            generation++;
            revision = null;
            previousQueue = null;
            heard = new org.json.JSONArray();
            order.reset();
            autoplay = false;
            queueKey = null;
            sleep.cancel();
            detachWindow();
            saved.clear();
            reporter.disconnect();
            player.disconnect(true, "");
            player.pause();
            player.stop();
            player.clearMediaItems();
            stopFadeWatches();
            access = null;
            player.setRepeatMode(Player.REPEAT_MODE_OFF);
            stopSelf();
            return persisted;
        }
        if ("cancelSleepTimer".equals(action)) { sleep.cancel(); fades.refresh(); return persisted; }
        if ("setSleepMinutes".equals(action) || "sleepAfterTrack".equals(action)) {
            if (count == 0) throw new IllegalStateException("Choose a track first.");
            if ("setSleepMinutes".equals(action)) sleep.minutes(value, to == 1);
            else sleep.afterTracks(trackIdentity(player.getCurrentMediaItem()), value < 1 ? 1 : value);
            fades.refresh();
            return persisted;
        }
        if (count == 0) return persisted;
        if ("prioritize".equals(action) && (value != item || item <= player.getCurrentMediaItemIndex() || item >= count))
            throw new IllegalArgumentException("Choose an upcoming track.");
        boolean edit = "clearUpcoming".equals(action) || "shuffleUpcoming".equals(action) || "prioritize".equals(action)
                || "move".equals(action) && item >= 0 && item < count && to >= 0 && to < count
                || "remove".equals(action) && item >= 0 && item < count;
        boolean editsPicks = "remove".equals(action) && item >= 0 && item < count && order.isExtra(player.getMediaItemAt(item))
                || "move".equals(action) && item >= 0 && item < count && to >= 0 && to < count
                    && order.isExtra(player.getMediaItemAt(item)) && order.isExtra(player.getMediaItemAt(to));
        if (edit && !"shuffleUpcoming".equals(action) && !"prioritize".equals(action) && !editsPicks) detachWindow();
        generation++;
        switch (action) {
            case "cycleRepeat":
                int repeat = repeatMode();
                setRepeat(repeat == Player.REPEAT_MODE_OFF ? Player.REPEAT_MODE_ALL
                        : repeat == Player.REPEAT_MODE_ALL ? Player.REPEAT_MODE_ONE : Player.REPEAT_MODE_OFF);
                break;
            case "clearUpcoming":
                order.remove(player, player.getCurrentMediaItemIndex()+1, count);
                player.removeMediaItems(player.getCurrentMediaItemIndex() + 1, count);
                break;
            case "shuffleUpcoming":
                changingWindow = true;
                try {
                    SavedQueue.ShuffleHistory history = access == null || order.shuffled() ? null
                            : SavedQueue.shuffleHistory(this, access.base.toString(), access.token, access.userId);
                    order.toggle(player, history);
                    if (history != null) persisted = SavedQueue.flushShuffle(history);
                } finally { changingWindow = false; }
                break;
            case "move":
                if (item >= 0 && item < count && to >= 0 && to < count) {
                    order.moving(player, item, to);
                    order.clear();
                    player.moveMediaItem(item, to);
                }
                break;
            case "prioritize":
                int target = order.insertion(player, "upNext");
                MediaItem entry = player.getMediaItemAt(item);
                boolean extra = order.isExtra(entry);
                order.remove(player, item, item + 1);
                if (item < target) target--;
                order.insert(Collections.singletonList(entry), player.getMediaItemAt(target > item ? target : target - 1));
                order.mark(Collections.singletonList(entry));
                if (extra) order.markExtras(Collections.singletonList(entry));
                if (item != target) player.moveMediaItem(item, target);
                break;
            case "remove":
                if (item >= 0 && item < count) {
                    order.remove(player, item, item+1);
                    if (item == count - 1 && item == player.getCurrentMediaItemIndex()) player.seekTo(item - 1, 0);
                    player.removeMediaItem(item);
                }
                break;
            case "retryLibraryWindow":
                pager.load(true);
                break;
            case "toggle":
                if (pager.waiting() || waitingRadio) {
                    pager.cancelAdvance();
                    wasPlaying = false;
                    player.pause();
                } else if (showsPauseControl()) {
                    wasPlaying = false;
                    player.pause();
                } else {
                    if (player.getPlaybackState() == Player.STATE_ENDED) player.seekTo(0);
                    if (player.getPlaybackState() == Player.STATE_IDLE) player.prepare();
                    player.play();
                }
                break;
            case "previous":
                pager.cancelAdvance();
                player.seekToPrevious();
                break;
            case "next":
                if (pager.attached() && player.getCurrentMediaItemIndex() == count - 1 && (pager.hasNext() || repeatLibrary)) {
                    pager.end(true);
                } else if (autoplay && player.getCurrentMediaItemIndex() == count-1 && repeatMode() == Player.REPEAT_MODE_OFF) startRadio();
                else player.seekToNextMediaItem();
                break;
            case "seek":
                pager.cancelAdvance();
                if (Double.isFinite(value)) player.seekTo((long) (Math.max(0, value) * 1000));
                break;
            case "skipTo":
                if (value != (int) value || value < 0 || value >= count) {
                    throw new IllegalArgumentException("Choose a track in the queue.");
                }
                pager.cancelAdvance();
                player.seekTo((int) value, 0);
                if (player.getPlaybackState() == Player.STATE_IDLE) player.prepare();
                player.play();
                break;
            default:
                throw new IllegalArgumentException("Unknown playback command.");
        }
        save(edit);
        return persisted;
    }

    private boolean showsPauseControl() {
        // Buffering can still be paused. An audio-focus interruption has stopped output.
        return player.getPlayWhenReady()
                && player.getPlaybackSuppressionReason() == Player.PLAYBACK_SUPPRESSION_REASON_NONE
                && player.getPlayerError() == null && player.getPlaybackState() != Player.STATE_ENDED;
    }

    private JSArray queueTracks() { return queueTracks(false); }

    private JSArray queueTracks(boolean libraryOnly) {
        JSArray tracks = new JSArray();
        for (int i = 0; i < player.getMediaItemCount(); i++) {
            if (libraryOnly && order.isExtra(player.getMediaItemAt(i))) continue;
            MediaItem item = player.getMediaItemAt(i);
            tracks.put(item.localConfiguration.tag);
        }
        return tracks;
    }

    void readWaveform(String trackId, String request, java.util.function.Consumer<JSObject> result) {
        MediaItem item = player.getCurrentMediaItem();
        Access owner = access;
        if (request.isEmpty() || owner == null || item == null || item.localConfiguration == null
                || !item.mediaId.equals(trackId)) {
            JSObject empty = new JSObject();
            empty.put("peaks", new JSArray());
            result.accept(empty);
            return;
        }
        double seconds = player.getDuration() == C.TIME_UNSET ? 0 : player.getDuration() / 1000.0;
        waveforms.read(request, getCacheDir(), owner, item.localConfiguration.uri, seconds, playbackHttp, result);
    }

    void cancelWaveform(String request) { waveforms.cancel(request); }

    @Nullable
    private JSObject currentQuality() {
        if (!player.destination().isEmpty()) return null;
        androidx.media3.common.Format format = localPlayback.getAudioFormat();
        if (format == null || format.sampleMimeType == null) return null;
        String codec;
        switch (format.sampleMimeType) {
            case "audio/raw": codec = "PCM"; break;
            case "audio/mp4a-latm": codec = "AAC"; break;
            case "audio/mpeg": codec = "MP3"; break;
            case "audio/opus": codec = "Opus"; break;
            case "audio/vorbis": codec = "Vorbis"; break;
            default: codec = format.sampleMimeType.replace("audio/", "").toUpperCase(java.util.Locale.ROOT);
        }
        JSObject out = new JSObject();
        out.put("format", codec);
        if (format.sampleRate > 0) out.put("sampleRate", format.sampleRate);
        if (format.averageBitrate > 0) out.put("bitrate", Math.round(format.averageBitrate / 1000f));
        if (androidx.media3.common.util.Util.isEncodingLinearPcm(format.pcmEncoding))
            out.put("bitDepth", androidx.media3.common.util.Util.getPcmFrameSize(format.pcmEncoding, 1) * 8);
        return out;
    }

    JSObject signalPath() {
        JSObject result = new JSObject();
        MediaItem current = player.getCurrentMediaItem();
        if (current == null) return result;
        result.put("id", current.mediaId);
        if (!player.destination().isEmpty()) {
            result.put("remote", true);
            result.put("destination", player.destination());
            if (castDelivery != null && castOccurrence == trackIdentity(current)) result.put("delivery", castDelivery.get());
            return result;
        }
        equalizer.describeOutput(result);
        result.put("delivery", audioSource.delivery(trackIdentity(current)));
        result.put("speed", localPlayback.getPlaybackParameters().speed);
        result.put("replayGain", sound.replayGainMode());
        return result;
    }

    private void consumePriority() {
        if (order.consume(player)) queueVersion = UUID.randomUUID().toString();
    }

    private JSArray bufferedRanges(@Nullable JSONObject track, double duration) {
        JSArray ranges = new JSArray();
        if (track == null || !(duration > 0) || !Double.isFinite(duration) || !player.destination().isEmpty()) return ranges;
        if (trackIdentity(localPlayback.getCurrentMediaItem()) != track) return ranges;
        boolean complete = audioSource.hasCompleteFile(track);
        // After a seek, Media3 only guarantees the continuous buffer ahead of the playhead.
        double start = complete ? 0 : Math.max(0, localPlayback.getCurrentPosition() / 1000.0);
        double end = complete ? duration : Math.min(duration, localPlayback.getBufferedPosition() / 1000.0);
        if (end > start) {
            JSObject range = new JSObject();
            range.put("start", start);
            range.put("end", end);
            ranges.put(range);
        }
        return ranges;
    }

    JSObject snapshot() { return snapshot(null); }

    JSObject snapshot(@Nullable String knownQueue) {
        sleep.check();
        int count = player.getMediaItemCount();
        int index = count == 0 ? -1 : player.getCurrentMediaItemIndex();
        Object current = trackIdentity(player.getCurrentMediaItem());
        JSONObject track = current instanceof JSONObject ? (JSONObject) current : null;
        boolean includeQueue = !queueVersion.equals(knownQueue);
        double duration = player.getDuration() == C.TIME_UNSET
                ? (track == null ? 0 : track.optDouble("duration", 0)) : player.getDuration() / 1000.0;
        if (player.remoteDuration() > 0) duration = player.remoteDuration() / 1000.0;
        JSObject result = new JSObject();
        int repeat = repeatMode();
        if (pager.attached()) {
            JSObject window = pager.status(count - order.extraCount());
            if (includeQueue && order.extraCount() > 0) window.put("extras", order.extraIndices(player));
            result.put("libraryWindow", window);
        }
        JSObject timer = new JSObject();
        long remaining = sleep.remaining();
        if (sleep.tracks() > 0) {
            timer.put("mode", "track");
            timer.put("remaining", sleep.tracks());
        } else if (remaining > 0) {
            timer.put("mode", "minutes");
            timer.put("endsAt", System.currentTimeMillis() + remaining);
            timer.put("finishTrack", sleep.finishLast());
        }
        result.put("sleepTimer", timer.length() > 0 ? timer : JSONObject.NULL);
        result.put("quality", currentQuality());
        result.put("queueVersion", queueVersion);
        if (includeQueue) {
            result.put("tracks", queueTracks());
            result.put("upNext", order.pending(player));
        }
        result.put("repeat", repeat == Player.REPEAT_MODE_ONE ? "one" : repeat == Player.REPEAT_MODE_ALL ? "all" : "off");
        result.put("shuffled", order.shuffled());
        result.put("hasPreviousQueue", previousQueue != null);
        result.put("autoplay", autoplay);
        if (radioProblem != null) result.put("autoplayProblem", radioProblem);
        result.put("index", index);
        result.put("playing", index >= 0 && (showsPauseControl() || pager.waiting() || radio != null));
        result.put("bufferedRanges", bufferedRanges(track, duration));
        result.put("position", player.getCurrentPosition() / 1000.0);
        result.put("duration", duration);
        result.put("error", !player.routeError().isEmpty() ? player.routeError()
                : player.getPlayerError() == null ? JSONObject.NULL : "This track could not be played.");
        return result;
    }

    @Override public void onDestroy() {
        readAhead.close();
        if (connectivity != null) connectivity.unregisterNetworkCallback(playbackConnectivity);
        stopFadeWatches();
        waveforms.close();
        cancelRadio();
        cancelHeadset();
        generation++;
        save(false);
        queueKey = null;
        main.removeCallbacks(checkpoint);
        pager.detach();
        reporter.close();
        sleep.cancel();
        fades.release();
        equalizer.close();
        access = null;
        PlayerWidget.render(this, null);
        main.removeCallbacks(stopEmptyExternalPlay);
        car.close();
        session.release();
        player.release();
        super.onDestroy();
    }
}
