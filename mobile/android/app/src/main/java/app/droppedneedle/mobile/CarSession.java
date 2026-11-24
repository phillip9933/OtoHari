package app.droppedneedle.mobile;

import android.os.Handler;
import android.content.Context;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.os.Looper;
import androidx.annotation.Nullable;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.Player;
import androidx.media3.session.LibraryResult;
import androidx.media3.session.MediaLibraryService.LibraryParams;
import androidx.media3.session.MediaLibraryService.MediaLibrarySession;
import androidx.media3.session.MediaSession;
import androidx.media3.session.SessionError;
import androidx.media3.session.SessionCommands;
import androidx.media3.session.SessionResult;
import com.getcapacitor.JSArray;
import com.google.common.collect.ImmutableList;
import com.google.android.gms.common.GoogleSignatureVerifier;
import com.google.common.util.concurrent.Futures;
import com.google.common.util.concurrent.ListenableFuture;
import com.google.common.util.concurrent.ListeningExecutorService;
import com.google.common.util.concurrent.MoreExecutors;
import com.google.common.util.concurrent.SettableFuture;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Executors;

@androidx.annotation.OptIn(markerClass = androidx.media3.common.util.UnstableApi.class)
class CarSession implements MediaLibrarySession.Callback {
    private final PlaybackService service;
    private final ListeningExecutorService io = MoreExecutors.listeningDecorator(Executors.newSingleThreadExecutor());
    private final Handler main = new Handler(Looper.getMainLooper());
    private volatile boolean closed;
    private int selecting;
    CarSession(PlaybackService service) { this.service = service; }
    void close() { closed = true; io.shutdownNow(); }
    boolean isSelecting() { return selecting > 0; }

    static final Player.Commands TRANSPORT_COMMANDS = new Player.Commands.Builder().addAll(
            Player.COMMAND_PLAY_PAUSE, Player.COMMAND_PREPARE, Player.COMMAND_STOP,
            Player.COMMAND_SEEK_TO_PREVIOUS, Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM,
            Player.COMMAND_SEEK_TO_NEXT, Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM).build();

    @Override public int onPlayerCommandRequest(MediaSession session, MediaSession.ControllerInfo controller, int command) {
        if (!TRANSPORT_COMMANDS.contains(command) && !mayBrowse(session, controller))
            return SessionError.ERROR_PERMISSION_DENIED;
        if (command == Player.COMMAND_PLAY_PAUSE) service.prepareExternalPlay();
        return SessionResult.RESULT_SUCCESS;
    }

    @Override public MediaSession.ConnectionResult onConnect(MediaSession session, MediaSession.ControllerInfo controller) {
        boolean catalog = mayBrowse(session, controller);
        if (!catalog && !controller.isTrusted()) return MediaSession.ConnectionResult.reject();
        Player.Commands player = catalog ? MediaSession.ConnectionResult.DEFAULT_PLAYER_COMMANDS.buildUpon()
                .remove(Player.COMMAND_SET_SHUFFLE_MODE).remove(Player.COMMAND_CHANGE_MEDIA_ITEMS).build() : TRANSPORT_COMMANDS;
        return new MediaSession.ConnectionResult.AcceptedResultBuilder(session)
                .setAvailablePlayerCommands(player)
                .setAvailableSessionCommands(catalog ? MediaSession.ConnectionResult.DEFAULT_SESSION_AND_LIBRARY_COMMANDS
                        : SessionCommands.EMPTY)
                .build();
    }

    private boolean mayBrowse(MediaSession session, MediaSession.ControllerInfo controller) {
        return controller.getUid() == android.os.Process.myUid()
                || verifiedCarHost(service, controller.getPackageName(), controller.getUid(),
                        session.isAutoCompanionController(controller), session.isAutomotiveController(controller));
    }
    @SuppressWarnings("deprecation") // Google's verifier reads PackageInfo.signatures.
    static boolean verifiedCarHost(Context context, String name, int uid, boolean companion, boolean automotive) {
        if (!companion && !automotive) return false;
        PackageManager packages = context.getPackageManager();
        try {
            PackageInfo host = packages.getPackageInfo(name, PackageManager.GET_SIGNATURES);
            if (host.applicationInfo == null || host.applicationInfo.uid != uid) return false;
            if (companion) return GoogleSignatureVerifier.getInstance(context).isGooglePublicSignedPackage(host);
            return packages.checkSignatures("android", name) == PackageManager.SIGNATURE_MATCH
                || (host.applicationInfo.flags & android.content.pm.ApplicationInfo.FLAG_SYSTEM) != 0;
        } catch (PackageManager.NameNotFoundException | SecurityException unavailable) {
            return false;
        }
    }
    @Override public ListenableFuture<LibraryResult<MediaItem>> onGetLibraryRoot(MediaLibrarySession session,
            MediaSession.ControllerInfo controller, @Nullable LibraryParams params) {
        return Futures.immediateFuture(mayBrowse(session, controller)
                ? LibraryResult.ofItem(CarLibrary.root().media(), params)
                : LibraryResult.ofError(SessionError.ERROR_PERMISSION_DENIED));
    }
    interface Query<T> { LibraryResult<T> read(CarLibrary catalog) throws Exception; }
    private <T> ListenableFuture<LibraryResult<T>> query(MediaLibrarySession session, MediaSession.ControllerInfo controller,
            Query<T> operation) {
        if (!mayBrowse(session, controller))
            return Futures.immediateFuture(LibraryResult.ofError(SessionError.ERROR_PERMISSION_DENIED));
        return io.submit(() -> {
            try {
                HeadsetAccount owner = HeadsetAccount.read(service);
                if (owner == null) return LibraryResult.ofError(SessionError.ERROR_SESSION_SETUP_REQUIRED);
                LibraryResult<T> result = operation.read(new CarLibrary(service, owner));
                return !closed && owner.matches(HeadsetAccount.read(service)) ? result :
                        LibraryResult.ofError(SessionError.ERROR_SESSION_AUTHENTICATION_EXPIRED);
            } catch (Exception failed) { return LibraryResult.ofError(SessionError.ERROR_IO); }
        });
    }
    @Override public ListenableFuture<LibraryResult<MediaItem>> onGetItem(MediaLibrarySession session,
            MediaSession.ControllerInfo controller, String id) {
        return query(session, controller, c -> LibraryResult.ofItem(c.item(id).media(), null));
    }
    private static List<MediaItem> media(List<CarLibrary.Entry> entries, int page, int size) {
        List<MediaItem> result = new ArrayList<>();
        for (CarLibrary.Entry entry : CarLibrary.slice(entries, page, size)) result.add(entry.media());
        return result;
    }
    @Override public ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> onGetChildren(MediaLibrarySession session,
            MediaSession.ControllerInfo controller, String parent, int page, int size, @Nullable LibraryParams params) {
        return query(session, controller, c -> LibraryResult.ofItemList(media(c.children(parent), page, size), params));
    }
    @Override public ListenableFuture<LibraryResult<Void>> onSearch(MediaLibrarySession session, MediaSession.ControllerInfo controller,
            String term, @Nullable LibraryParams params) {
        return query(session, controller, c -> {
            int count = c.search(term).size();
            main.post(() -> { if (!closed) session.notifySearchResultChanged(controller, term, count, params); });
            return LibraryResult.ofVoid(params);
        });
    }
    @Override public ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> onGetSearchResult(MediaLibrarySession session,
            MediaSession.ControllerInfo controller, String term, int page, int size, @Nullable LibraryParams params) {
        return query(session, controller, c -> LibraryResult.ofItemList(media(c.search(term), page, size), params));
    }
    @Override public ListenableFuture<MediaSession.MediaItemsWithStartPosition> onSetMediaItems(MediaSession session,
            MediaSession.ControllerInfo controller, List<MediaItem> requests, int startIndex, long position) {
        if (!mayBrowse(session, controller))
            return Futures.immediateFailedFuture(new SecurityException("Catalog selection is unavailable."));
        if (requests.size() != 1) return Futures.immediateFailedFuture(new IllegalArgumentException("Choose a DN item."));
        MediaItem request = requests.get(0);
        String term = request.requestMetadata.searchQuery;
        long generation = service.carGeneration();
        SettableFuture<MediaSession.MediaItemsWithStartPosition> result = SettableFuture.create();
        selecting++;
        result.addListener(() -> main.post(() -> selecting--), MoreExecutors.directExecutor());
        io.execute(() -> {
            try {
                HeadsetAccount owner = HeadsetAccount.read(service);
                if (owner == null) throw new IOException("Sign into DroppedNeedle first.");
                CarLibrary catalog = new CarLibrary(service, owner);
                List<CarLibrary.Entry> rows = term == null ? catalog.siblings(request.mediaId) : catalog.search(term);
                JSArray tracks = new JSArray();
                int selected = -1;
                for (CarLibrary.Entry entry : rows) {
                    if (entry.track == null) continue;
                    if (request.mediaId.equals(entry.id) || term != null && selected < 0) selected = tracks.length();
                    tracks.put(entry.track);
                }
                if (selected < 0 || !owner.matches(HeadsetAccount.read(service))) throw new IOException("No matching song.");
                final int index = selected;
                main.post(() -> {
                    try {
                        if (closed || result.isCancelled() || generation != service.carGeneration()) throw new IOException("Playback changed.");
                        result.set(service.prepareCarQueue(owner, tracks, index, position == C.TIME_UNSET ? 0 : Math.max(0, position)));
                    } catch (Exception error) { result.setException(error); }
                });
            } catch (Exception failed) { result.setException(failed); }
        });
        return result;
    }
}
