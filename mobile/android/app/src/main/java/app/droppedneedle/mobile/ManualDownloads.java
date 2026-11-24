package app.droppedneedle.mobile;

import android.content.Context;
import android.database.sqlite.SQLiteDatabase;
import android.net.ConnectivityManager;
import androidx.annotation.Nullable;
import java.io.IOException;
import java.io.InputStream;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;
import java.util.function.Supplier;
import okhttp3.Call;
import okhttp3.HttpUrl;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;
import org.json.JSONArray;
import org.json.JSONObject;

final class ManualDownloads {
    interface Scheduler {
        void start(OfflineStore store, boolean replace) throws Exception;
        void cancel(String owner);
        boolean pending(String owner) throws Exception;
    }
    interface Progress { void update(int finished, int total); }
    static final class Run {
        final String owner;
        volatile boolean stopped;
        private Call call;
        private String session;
        Run(String owner) { this.owner = owner; }
        synchronized void stop() { stopped = true; if (call != null) call.cancel(); }
        synchronized void requesting(@Nullable Call next) throws IOException {
            if (stopped && next != null) throw new IOException("Download stopped.");
            call = next;
        }
    }

    private static ManualDownloads instance;
    static synchronized ManualDownloads get(Context ctx) {
        Context app = ctx.getApplicationContext();
        if (instance == null) instance = new ManualDownloads(app, new ManualDownloadQueue(app),
                () -> HeadsetAccount.read(app), new ManualDownloadScheduler(app), () -> {
                    ConnectivityManager network = app.getSystemService(ConnectivityManager.class);
                    return network != null && network.getActiveNetwork() != null;
                });
        return instance;
    }
    static final OkHttpClient HTTP = new OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
            .readTimeout(30, TimeUnit.SECONDS).build();
    private final Context context;
    private final ManualDownloadQueue queue;
    private final Supplier<HeadsetAccount> login;
    private final Scheduler scheduler;
    private final BooleanSupplier online;
    volatile Runnable changed;
    private volatile Run active;
    private String currentId;
    private JSONObject currentTrack;

    ManualDownloads(Context context, ManualDownloadQueue queue, Supplier<HeadsetAccount> login, Scheduler scheduler, BooleanSupplier online) {
        this.context = context;
        this.queue = queue;
        this.login = login;
        this.scheduler = scheduler;
        this.online = online;
    }
    private void changed() { Runnable listener = changed; if (listener != null) listener.run(); }
    private static String session(HeadsetAccount owner) { return OfflineStore.digest("dn.manual.v1\0" + owner.token); }
    private OfflineStore store(HeadsetAccount owner) { return OfflineStore.forUser(context, owner.server.toString(), owner.userId); }
    private HeadsetAccount requireOwner(OfflineStore store) {
        HeadsetAccount owner = login.get();
        if (owner == null || !store.account.equals(store(owner).account))
            throw new IllegalArgumentException("Reconnect to this DN account to download.");
        return owner;
    }
    synchronized JSONObject status(OfflineStore store) throws Exception {
        String stamp = queue.session(store.account);
        if (stamp != null && HeadsetAccount.unlocked(context)) {
            HeadsetAccount owner = login.get();
            if (owner == null || !store.account.equals(store(owner).account) || !stamp.equals(session(owner))) cancel(store.account);
        }
        if (promote(store)) schedule(store, false);
        ManualDownloadQueue.Counts count = queue.counts(store.account);
        if (count.pending() > 0 && !store.offlineOnly() && (active == null || active.stopped)
                && !scheduler.pending(store.account)) {
            queue.failPending(store.account, "Android stopped the downloads. Retry to continue.");
            count = queue.counts(store.account);
        }
        int total = count.pending() + count.saved() + count.failed();
        String state;
        if (count.pending() == 0) state = count.failed() > 0 ? "failed" : total > 0 ? "complete" : "idle";
        else if (store.offlineOnly()) state = "waitingOffline";
        else if (!online.getAsBoolean() || !store.permittedNetwork()) state = "waitingNetwork";
        else state = active != null && !active.stopped && active.owner.equals(store.account) ? "downloading" : "queued";
        return new JSONObject().put("state", state).put("pending", count.pending()).put("failed", count.failed())
                .put("current", state.equals("downloading") ? currentTrack : null)
                .put("failures", count.failed() == 0 ? new JSONArray() : queue.failures(store.account))
                .put("saved", count.saved()).put("total", total).put("lastError", count.error());
    }
    synchronized ManualDownloadQueue.Counts counts(OfflineStore store) { return queue.counts(store.account); }
    synchronized JSONObject enqueue(OfflineStore store, JSONArray tracks) throws Exception {
        HeadsetAccount owner = requireOwner(store);
        String stamp = session(owner);
        if (active != null && (!active.owner.equals(store.account) || !stamp.equals(active.session))) active.stop();
        Set<String> added;
        SQLiteDatabase db = queue.getWritableDatabase();
        db.beginTransaction();
        try {
            added = queue.admit(store, stamp, tracks);
            if (!owner.matches(login.get())) throw new IllegalArgumentException("The DN account changed.");
            // The worker shares this monitor. It cannot consume the scheduled selection before commit.
            if (!store.offlineOnly() && queue.next(store.account) != null) scheduler.start(store, false);
            db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
        // A rejected admission has no effect on file eviction or pin status.
        if (promote(store)) schedule(store, false);
        int saved = 0, queued = 0, overlap = 0, failed = 0;
        Set<String> seen = new HashSet<>();
        for (int i = 0; i < tracks.length(); i++) {
            String id = tracks.getJSONObject(i).getString("id");
            if (!seen.add(id)) continue;
            int state = queue.state(store.account, id);
            if (state == ManualDownloadQueue.SAVED) saved++;
            else if (!added.contains(id)) overlap++;
            else if (state == ManualDownloadQueue.FAILED) failed++;
            else queued++;
        }
        changed();
        return new JSONObject().put("saved", saved).put("queued", queued).put("alreadyQueued", overlap).put("failed", failed)
                .put("status", status(store));
    }
    /** Finish local pins after durable admission, including an interrupted enqueue. */
    private boolean promote(OfflineStore store) throws Exception {
        ManualDownloadQueue.Item item = queue.next(store.account, ManualDownloadQueue.LOCAL);
        if (item == null) return false;
        HeadsetAccount owner = login.get();
        if (owner == null || !store.account.equals(store(owner).account) || !item.session().equals(session(owner))) return false;
        boolean missing = false;
        SQLiteDatabase db = queue.getWritableDatabase();
        db.beginTransaction();
        try {
            do {
                try {
                    boolean kept = store.keepExisting(item.id(), null, item.track());
                    queue.finish(store.account, item.id(), kept ? ManualDownloadQueue.SAVED : ManualDownloadQueue.PENDING, "");
                    if (!kept) missing = true;
                } catch (IOException unavailable) {
                    queue.finish(store.account, item.id(), ManualDownloadQueue.FAILED, "Device storage could not keep this song.");
                }
                item = queue.next(store.account, ManualDownloadQueue.LOCAL);
            } while (item != null);
            db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
        return missing;
    }
    private void schedule(OfflineStore store, boolean replace) {
        if (store.offlineOnly() || queue.counts(store.account).pending() == 0) return;
        try { scheduler.start(store, replace); }
        catch (Exception unavailable) { queue.failPending(store.account, "Android could not schedule these downloads. Retry to continue."); }
    }
    synchronized JSONObject retry(OfflineStore store) throws Exception {
        requireOwner(store);
        queue.retry(store.account);
        schedule(store, false);
        changed();
        return status(store);
    }
    void interrupt(String owner) {
        Run run = active;
        if (run != null && run.owner.equals(owner)) run.stop();
    }
    synchronized JSONObject cancel(OfflineStore store) throws Exception {
        cancel(store.account);
        return status(store);
    }
    synchronized void cancel(String owner) {
        interrupt(owner);
        queue.clear(owner);
        scheduler.cancel(owner);
        changed();
    }
    synchronized void policyChanged(OfflineStore store) {
        if (active != null && active.owner.equals(store.account)) active.stop();
        if (store.offlineOnly()) scheduler.cancel(store.account);
        else schedule(store, true);
        changed();
    }
    synchronized void remove(OfflineStore store, JSONArray ids) throws Exception {
        for (int i = 0; i < ids.length(); i++)
            if (active != null && active.owner.equals(store.account) && ids.getString(i).equals(currentId))
                active.stop();
        queue.remove(store.account, ids);
        store.remove(ids);
        if (active != null && active.stopped) schedule(store, false);
        changed();
    }
    private static final class HttpFailure extends IOException {
        final int code;
        HttpFailure(int code) {
            super(code == 200 ? "DN returned a response without playable audio." : "DN could not serve this audio file (HTTP " + code + ").");
            this.code = code;
        }
    }
    private static final class LocalFailure extends IOException {
        LocalFailure() { super("Could not save this audio file. Check the 512 MiB per-track limit and available device storage."); }
    }

    boolean drain(Run run, Call.Factory http, Progress progress) {
        try {
            return transfer(run, http, progress);
        } catch (Exception failure) {
            synchronized (this) {
                if (!run.stopped) queue.failPending(run.owner, "Could not finish saving. Check device storage and retry.");
            }
            return false;
        } finally {
            synchronized (this) {
                if (active == run) { active = null; currentId = null; currentTrack = null; }
                changed();
            }
        }
    }
    private boolean transfer(Run run, Call.Factory http, Progress progress) throws Exception {
        HeadsetAccount owner;
        OfflineStore store;
        synchronized (this) {
            if (run.stopped || active != null && !active.stopped) return false;
            if (!HeadsetAccount.unlocked(context)) return true;
            owner = login.get();
            if (owner == null || !(store = store(owner)).account.equals(run.owner)) {
                queue.clear(run.owner);
                return false;
            }
            promote(store);
            run.session = session(owner);
            active = run;
            changed();
        }
        int sinceRatings = 100;
        while (!run.stopped) {
            ManualDownloadQueue.Item item;
            synchronized (this) {
                if (run.stopped) return false;
                item = queue.next(run.owner);
                if (item == null) return false;
                if (!item.session().equals(session(owner)) || !owner.matches(login.get())) {
                    queue.clear(run.owner);
                    return false;
                }
                currentId = item.id();
                if (store.keepExisting(item.id(), null, item.track())) {
                    queue.finish(run.owner, item.id(), ManualDownloadQueue.SAVED, "");
                    changed();
                    continue;
                }
                if (store.offlineOnly()) return false;
                if (!online.getAsBoolean() || !store.permittedNetwork()) return true;
            }
            if (sinceRatings >= 100) {
                enrich(run, owner, store, http);
                sinceRatings = 0;
                synchronized (this) { item = queue.next(run.owner); }
                if (item == null || run.stopped) return false;
            }
            sinceRatings++;
            try {
                fetch(run, owner, store, item, http);
            } catch (IOException error) {
                synchronized (this) {
                    if (run.stopped || store.offlineOnly()) return false;
                    if (!owner.matches(login.get())) { queue.clear(run.owner); return false; }
                    if (!online.getAsBoolean() || !store.permittedNetwork()) return true;
                    if (error instanceof HttpFailure rejected && (rejected.code == 401 || rejected.code == 403)) {
                        queue.failPending(run.owner, "DN denied the download. Reconnect to your account and retry.");
                        return false;
                    }
                    if (error instanceof LocalFailure) {
                        queue.failPending(run.owner, error.getMessage());
                        return false;
                    }
                    boolean transientFailure = !(error instanceof HttpFailure h) || h.code == 408 || h.code == 429 || h.code >= 500;
                    if (transientFailure && item.tries() < 2) {
                        queue.attempt(run.owner, item.id());
                        return true;
                    }
                    queue.finish(run.owner, item.id(), ManualDownloadQueue.FAILED,
                            error instanceof HttpFailure ? error.getMessage()
                                    : "DN could not finish the download. Check the connection and retry.");
                }
            } finally {
                run.requesting(null);
                synchronized (this) { if (active == run) currentTrack = null; }
            }
            ManualDownloadQueue.Counts counts = queue.counts(run.owner);
            progress.update(counts.saved() + counts.failed(), counts.saved() + counts.failed() + counts.pending());
            changed();
        }
        return false;
    }

    private void enrich(Run run, HeadsetAccount owner, OfflineStore store, Call.Factory http) throws Exception {
        JSONArray ids = queue.unrated(run.owner);
        if (ids.length() == 0) return;
        HttpUrl url = owner.server.newBuilder().addPathSegments("api/v3/ratings/lookup").build();
        RequestBody payload = RequestBody.create(MediaType.get("application/json"), new JSONObject().put("track_ids", ids).toString());
        Call call = http.newCall(new Request.Builder().url(url).header("Authorization", "Bearer " + owner.token).post(payload).build());
        call.timeout().timeout(5, TimeUnit.SECONDS);
        try {
            synchronized (this) {
                if (run.stopped || store.offlineOnly() || !store.permittedNetwork() || !owner.matches(login.get())) return;
                run.requesting(call);
            }
            try (Response response = call.execute()) {
                ResponseBody body = response.body();
                if (!response.isSuccessful() || body == null || body.contentLength() > 128 * 1024
                        || body.source().request(128 * 1024 + 1)) return;
                JSONObject ratings = new JSONObject(body.string()).optJSONObject("tracks");
                synchronized (this) {
                    if (!run.stopped && ratings != null && owner.matches(login.get())) queue.ratings(run.owner, ids, ratings);
                }
            }
        } catch (IOException | org.json.JSONException ignored) {
            // Ratings are optional when DN cannot supply them.
        } finally { run.requesting(null); }
    }

    private void fetch(Run run, HeadsetAccount owner, OfflineStore store, ManualDownloadQueue.Item item,
            Call.Factory http) throws Exception {
        long revision = store.itemRevision(item.id());
        StreamProfiles.Quality quality = store.downloadQuality();
        currentTrack = ManualDownloadQueue.summary(item.track());
        changed();
        try (Response response = DownloadRepresentation.open(store.original(item.id()), owner.token, quality.format, quality.rate, request -> {
            Call call = http.newCall(request);
            synchronized (this) {
                if (run.stopped || store.offlineOnly() || !store.permittedNetwork() || !owner.matches(login.get()))
                    throw new IOException("Download stopped.");
                run.requesting(call);
            }
            return call.execute();
        })) {
            String mime = DownloadRepresentation.mime(response);
            if (mime == null) throw new HttpFailure(response.code());
            ResponseBody body = response.body();
            OfflineStore.Capture capture;
            try { capture = store.begin(item.track(), true, body.contentLength()); }
            catch (IOException storage) { throw new LocalFailure(); }
            try (OfflineStore.Capture sink = capture; InputStream input = body.byteStream()) {
                byte[] buf = new byte[65536];
                int count;
                long bytes = 0;
                while ((count = input.read(buf)) != -1) {
                    if (run.stopped) throw new IOException("Download stopped.");
                    bytes += count;
                    try { sink.write(buf, 0, count); } catch (IOException storage) { throw new LocalFailure(); }
                }
                if (bytes == 0 || body.contentLength() >= 0 && bytes != body.contentLength())
                    throw new IOException("DN returned an incomplete audio file.");
                synchronized (this) {
                    if (run.stopped || store.offlineOnly() || !store.permittedNetwork() || !owner.matches(login.get())
                            || revision != store.itemRevision(item.id()) || queue.state(run.owner,item.id()) != ManualDownloadQueue.PENDING)
                        throw new IOException("Download stopped.");
                    try { sink.finish(mime); } catch (IOException storage) { throw new LocalFailure(); }
                    queue.finish(run.owner, item.id(), ManualDownloadQueue.SAVED, "");
                }
            }
        }
    }
}
