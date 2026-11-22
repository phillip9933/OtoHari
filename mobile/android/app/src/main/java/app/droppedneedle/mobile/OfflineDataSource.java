package app.droppedneedle.mobile;

import android.net.Uri;
import androidx.annotation.Nullable;
import androidx.media3.common.C;
import androidx.media3.datasource.DataSource;
import androidx.media3.datasource.DataSpec;
import androidx.media3.datasource.FileDataSource;
import androidx.media3.datasource.HttpDataSource;
import androidx.media3.datasource.TransferListener;
import com.getcapacitor.JSObject;
import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import org.json.JSONException;
import org.json.JSONObject;

/** Route a library stream to its complete local copy, or capture the original playback read. */
@androidx.annotation.OptIn(markerClass = androidx.media3.common.util.UnstableApi.class)
final class OfflineDataSource implements DataSource {
    interface Library {
        @Nullable OfflineStore store();
        @Nullable JSONObject metadata(String id);
    }
    private final Library library;
    private final DataSource.Factory online;
    private final ConversionSource.Timeline timeline;
    @Nullable private final StreamProfiles.Selection selection;
    private boolean originalFallback;
    private final List<TransferListener> listeners = new ArrayList<>();
    private DataSource source;
    private OfflineStore.Capture capture;
    private ConversionSource.OpenedAudio opened;
    private long expected;
    private long read;

    OfflineDataSource(Library library, DataSource.Factory online) {
        this(library, online, new ConversionSource.Timeline(C.TIME_UNSET));
    }
    OfflineDataSource(Library library, DataSource.Factory online, ConversionSource.Timeline timeline) {
        this(library, online, timeline, null);
    }
    OfflineDataSource(Library library, DataSource.Factory online, ConversionSource.Timeline timeline,
            @Nullable StreamProfiles.Selection selection) {
        this.selection = selection;
        this.timeline = timeline;
        this.library = library;
        this.online = online;
    }

    @Override
    public void addTransferListener(TransferListener listener) {
        listeners.add(listener);
        if (source != null)
            source.addTransferListener(listener);
    }

    @Override
    public long open(DataSpec spec) throws IOException {
        String url = spec.uri.toString();
        OfflineStore store = library == null ? null : library.store();
        File file = store == null ? null : store.playable(url);
        if (file == null && store != null && store.offlineOnly()) {
            throw new IOException("This song is not stored on this device.");
        }
        long base = timeline.base(spec.position);
        long startMs = timeline.startMs(spec.position);
        Uri representation = spec.uri;
        if (file == null && selection != null) representation = selection.forRequest(spec.uri);
        if (originalFallback) representation = ConversionSource.original(representation);
        Uri uri = file != null ? Uri.fromFile(file)
                : (startMs > 0 && !originalFallback ? ConversionSource.streamAt(representation, startMs) : representation);
        DataSpec physical = spec.buildUpon().setUri(uri).setPosition(spec.position - base).build();
        try {
            expected = openSource(file == null ? online.createDataSource() : new FileDataSource(), physical);
        } catch (HttpDataSource.InvalidResponseCodeException denied) {
            if (denied.responseCode != 409 || !ConversionSource.requested(uri)) throw denied;
            source.close();
            representation = ConversionSource.original(spec.uri);
            expected = openSource(online.createDataSource(), physical.withUri(representation));
            originalFallback = true;
        }
        opened = new ConversionSource.OpenedAudio(file);
        timeline.opened = opened;
        if (file == null && selection != null) selection.opened(representation);
        if (file == null) timeline.delivery = StreamProfiles.networkDelivery(selection, representation, header("Accept-Ranges"), originalFallback);
        else {
            JSObject delivery = new JSObject();
            delivery.put("source", store.playbackOrigin(url, file));
            timeline.delivery = delivery;
        }
        read = 0;
        if (file == null && store != null && store.cacheEnabled() && spec.position == 0
                && spec.uri.getQueryParameter("start_seconds") == null && spec.length == C.LENGTH_UNSET
                && OfflineStore.isAudio(header("Content-Type"))) {
            // A range response is complete only if it covers the whole resource from byte zero.
            String range = header("Content-Range");
            if (range == null || (expected > 0 && range.equals("bytes 0-" + (expected - 1) + "/" + expected))) {
                String id = store.trackId(url);
                JSONObject track = id == null ? null : library.metadata(id);
                if (track != null) {
                    try {
                        capture = store.begin(track, false, expected);
                    } catch (IOException | JSONException unavailable) {
                        capture = null;
                    }
                }
            }
        }
        return expected;
    }

    private long openSource(DataSource selected, DataSpec spec) throws IOException {
        source = selected;
        for (TransferListener listener : listeners)
            source.addTransferListener(listener);
        return source.open(spec);
    }
    @Nullable
    private String header(String name) {
        for (Map.Entry<String, List<String>> entry : source.getResponseHeaders().entrySet()) {
            if (name.equalsIgnoreCase(entry.getKey()) && !entry.getValue().isEmpty())
                return entry.getValue().get(0);
        }
        return null;
    }

    @Override
    public int read(byte[] buffer, int offset, int length) throws IOException {
        int count = source.read(buffer, offset, length);
        if (capture != null) {
            try {
                if (count > 0) {
                    capture.write(buffer, offset, count);
                    read += count;
                }
                if (count == C.RESULT_END_OF_INPUT || (expected >= 0 && read == expected)) {
                    capture.finish();
                    opened.file = capture.installedFile;
                    closeCapture();
                }
            } catch (IOException | JSONException ignored) {
                // A full disk or a removed cache entry must not interrupt the music.
                closeCapture();
            }
        }
        return count;
    }
    private void closeCapture() {
        if (capture == null)
            return;
        try {
            capture.close();
        } catch (IOException ignored) { /* No incomplete file is indexed. */
        }
        capture = null;
    }
    @Nullable
    @Override
    public Uri getUri() {
        return source == null ? null : source.getUri();
    }
    @Override
    public Map<String, List<String>> getResponseHeaders() {
        return source == null ? Collections.emptyMap() : source.getResponseHeaders();
    }
    @Override
    public void close() throws IOException {
        closeCapture();
        if (source != null) {
            try {
                source.close();
            } finally {
                source = null;
            }
        }
    }
}
