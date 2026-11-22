package app.droppedneedle.mobile;

import static org.junit.Assert.*;

import android.app.Instrumentation;
import android.content.Context;
import android.net.Uri;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.datasource.ByteArrayDataSource;
import androidx.media3.datasource.DataSource;
import androidx.media3.datasource.DataSpec;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

@androidx.annotation.OptIn(markerClass = androidx.media3.common.util.UnstableApi.class)
@RunWith(AndroidJUnit4.class)
public final class OfflinePlaybackTest {
    private static final String BASE = "https://offline.example/dn";
    private static final String URI = BASE + "/api/v3/stream/local/t";
    private final Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
    private final Context context = instrumentation.getTargetContext();
    private final String listener = UUID.randomUUID().toString();
    private final AtomicInteger requests = new AtomicInteger();
    private final OfflineStore store = OfflineStore.forUser(context, BASE, listener);

    private static JSONObject track() throws JSONException {
        return new JSONObject()
                .put("id", "t")
                .put("title", "Fixture tone")
                .put("artist", "Test artist")
                .put("album", "Test record")
                .put("streamUrl", URI);
    }
    private OfflineDataSource source(OfflineStore owner, DataSource.Factory upstream) throws JSONException {
        JSONObject metadata = track();
        return new OfflineDataSource(new OfflineDataSource.Library() {
            @Override
            public OfflineStore store() {
                return owner;
            }
            @Override
            public JSONObject metadata(String id) {
                return metadata;
            }
        }, upstream);
    }
    static byte[] wav() {
        int count = 4000;
        ByteBuffer file = ByteBuffer.allocate(44 + count * 2).order(ByteOrder.LITTLE_ENDIAN);
        file.put("RIFF".getBytes(StandardCharsets.US_ASCII)).putInt(36 + count * 2);
        file.put("WAVEfmt ".getBytes(StandardCharsets.US_ASCII)).putInt(16);
        file.putShort((short) 1).putShort((short) 1).putInt(8000).putInt(16000).putShort((short) 2).putShort(
                (short) 16);
        file.put("data".getBytes(StandardCharsets.US_ASCII)).putInt(count * 2);
        return file.array();
    }
    @Test public void waveformMeasuresTheFileInsteadOfInventingPeaks() throws Exception {
        byte[] song = wav();
        ByteBuffer pcm = ByteBuffer.wrap(song).order(ByteOrder.LITTLE_ENDIAN);
        for (int i = 2000; i < 4000; i++) pcm.putShort(44 + i * 2, (short) (i % 2 == 0 ? 16000 : -16000));
        File audio = File.createTempFile("waveform-", ".wav", InstrumentationRegistry.getInstrumentation().getTargetContext().getCacheDir());
        try {
            try (java.io.FileOutputStream output = new java.io.FileOutputStream(audio)) { output.write(song); }
            float[] peaks = TrackWaveform.decode(audio, .5);
            assertEquals(TrackWaveform.BINS, peaks.length);
            assertEquals(0f, peaks[12], .001f);
            assertEquals(16000f / 32768f, peaks[84], .005f);
        } finally { audio.delete(); }
    }
    @Test
    public void savedAudioPlaysToEndAfterReopeningWithNoNetworkSource() throws Exception {
        byte[] audio = wav();
        OfflineStore.Capture capture = store.begin(track(), true, audio.length);
        try {
            try (OfflineStore.Capture writing = capture) {
                writing.write(audio, 0, audio.length);
                writing.finish();
            }
            OfflineStore reopened = OfflineStore.forUser(context, BASE, listener);
            assertEquals("Fixture tone",
                    reopened.snapshot().getJSONArray("items").getJSONObject(0).getJSONObject("track").getString(
                            "title"));
            assertNull(OfflineStore.forUser(context, BASE, listener + "-other").playable(URI));
            assertNull(OfflineStore.forUser(context, BASE + "/elsewhere", listener).playable(URI));
            assertNull(reopened.playable("https://other.example/dn/api/v3/stream/local/t"));
            assertNotNull(reopened.playable(URI + "?format=mp3&max_bitrate=128"));
            play(reopened);
            assertEquals("Reading a saved track must never create an HTTP data source", 0, requests.get());
            reopened.clearCache();
            assertNotNull(reopened.playable(URI));
        } finally {
            store.remove(new JSONArray().put("t"));
        }
        assertNull(store.playable(URI));
    }

    private void play(OfflineStore reopened) throws Exception {
        CompletableFuture<Boolean> ended = new CompletableFuture<>();
        ExoPlayer[] player = new ExoPlayer[1];
        DataSource.Factory local = () -> {
            try {
                return source(reopened, () -> {
                    requests.incrementAndGet();
                    throw new AssertionError("An offline playback attempted to use the network.");
                });
            } catch (JSONException impossible) {
                throw new AssertionError(impossible);
            }
        };
        instrumentation.runOnMainSync(() -> {
            player[0] = new ExoPlayer.Builder(context)
                                .setMediaSourceFactory(
                                        new DefaultMediaSourceFactory(context).setDataSourceFactory(local))
                                .build();
            player[0].setVolume(0f);
            player[0].addListener(new Player.Listener() {
                @Override
                public void onPlaybackStateChanged(int state) {
                    if (state == Player.STATE_ENDED)
                        ended.complete(true);
                }
                @Override
                public void onPlayerError(PlaybackException err) {
                    ended.completeExceptionally(err);
                }
            });
            player[0].setMediaItem(MediaItem.fromUri(URI + "?format=mp3"));
            player[0].prepare();
            player[0].play();
        });
        try {
            assertTrue(ended.get(12, TimeUnit.SECONDS));
        } finally {
            instrumentation.runOnMainSync(() -> player[0].release());
        }
    }

    @Test
    public void partialAndCancelledDownloadsStayInvisibleAndClearPreservesPins() throws Exception {
        byte[] data = wav();
        store.configure(new JSONObject()
                        .put("autoCache", true)
                        .put("offlineOnly", false)
                        .put("unmeteredOnly", false)
                        .put("cacheMiB", 128));
        try {
            try (OfflineStore.Capture writing = store.begin(track(), false, data.length)) {
                writing.write(data, 0, 100);
            }
            assertNull(store.playable(URI));
            try (OfflineStore.Capture writing = store.begin(track(), false, data.length)) {
                writing.write(data, 0, data.length);
                store.clearCache();
                writing.finish();
            }
            assertNull(store.playable(URI));
            try (OfflineStore.Capture writing = store.begin(track(), false, data.length)) {
                writing.write(data, 0, data.length);
                writing.finish();
            }
            assertFalse(store.snapshot().getJSONArray("items").getJSONObject(0).getBoolean("pinned"));
            assertTrue(store.pinExisting("t"));
            store.clearCache();
            assertNotNull(store.playable(URI));
            store.remove(new JSONArray().put("t"));
            assertEquals(0, store.snapshot().getJSONArray("items").length());
            try (OfflineStore.Capture writing = store.begin(track(), true, data.length)) {
                writing.write(data, 0, 100);
                assertThrows(IOException.class, writing::finish);
            }
            assertNull(store.playable(URI));
        } finally {
            store.remove(new JSONArray().put("t"));
        }
    }
    @Test
    public void aConcurrentDownloadDoesNotMarkThePlaybackRenditionAsFullyCached() throws Exception {
        byte[] audio = wav();
        store.configure(store.options().put("autoCache", true).put("unmeteredOnly", false));
        try (OfflineStore.Capture playback = store.begin(track(), false, audio.length);
             OfflineStore.Capture pinned = store.begin(track(), true, audio.length - 2)) {
            playback.write(audio, 0, 100);
            assertNull(playback.installedFile);
            pinned.write(audio, 0, audio.length - 2);
            pinned.finish();
            assertEquals(store.playable(URI), pinned.installedFile);
            playback.write(audio, 100, audio.length - 100);
            playback.finish();
            assertNull(playback.installedFile);
        } finally {
            store.remove(new JSONArray().put("t"));
        }
    }

    @Test
    public void automaticSourcesRetainRealAudioAndManualSavesSurviveRotation() throws Exception {
        byte[] audio = wav();
        JSONObject metadata = track().put("genre", "Folk").put("year", 2004).put("rating", 5);
        assertEquals("off", store.options().getString("autoDownload"));
        assertNull(store.begin(metadata, OfflineStore.AUTOMATIC, "recent", audio.length));
        JSONObject opts = store.options().put("autoCache", true).put("autoDownload", "recent")
                                  .put("downloadMiB", 128).put("unmeteredOnly", false);
        store.configure(opts);
        try {
            // The library only includes data that has reached the atomic completion point.
            try (OfflineStore.Capture partial = store.begin(metadata, OfflineStore.AUTOMATIC, "recent", audio.length)) {
                partial.write(audio, 0, 100);
            }
            assertEquals(0, store.snapshot().getJSONArray("items").length());
            try (OfflineStore.Capture complete = store.begin(metadata, false, audio.length)) {
                complete.write(audio, 0, audio.length);
                complete.finish();
            }
            assertEquals("cached", store.snapshot().getJSONArray("items").getJSONObject(0).getString("origin"));
            File before = store.playable(URI);
            assertTrue(store.keepExisting("t", "recent", metadata));
            assertEquals(before, store.playable(URI));
            assertEquals("automatic", store.snapshot().getJSONArray("items").getJSONObject(0).getString("origin"));
            store.clearCache();
            assertEquals(before, store.playable(URI));
            assertEquals(0, store.planAutomatic("recent", new JSONArray().put("t")).getJSONArray("ids").length());

            assertTrue(store.pinExisting("t"));
            store.planAutomatic("recent", new JSONArray());
            OfflineStore again = OfflineStore.forUser(context, BASE, listener);
            JSONObject row = again.snapshot().getJSONArray("items").getJSONObject(0);
            assertEquals("downloaded", row.getString("origin"));
            assertEquals(5, row.getJSONObject("track").getInt("rating"));
            assertEquals("Folk", row.getJSONObject("track").getString("genre"));
            assertEquals(before, again.playable(URI));
            assertNull(OfflineStore.forUser(context, BASE, listener + "-other").playable(URI));
            store.remove(new JSONArray().put("t"));
            assertEquals(0, store.planAutomatic("recent", new JSONArray().put("t")).getJSONArray("ids").length());
            assertNull(store.begin(metadata, OfflineStore.AUTOMATIC, "recent", audio.length));
        } finally { store.remove(new JSONArray().put("t")); }
    }

    @Test
    public void automaticRequestsObeyBudgetAndChangesWhileTransferring() throws Exception {
        byte[] audio = wav();
        JSONObject opts = store.options().put("autoDownload", "recent").put("downloadMiB", 128).put("unmeteredOnly", false);
        store.configure(opts);
        try {
            assertThrows(IOException.class, () -> store.begin(track(), OfflineStore.AUTOMATIC, "recent", 129L * 1024 * 1024));
            try (OfflineStore.Capture started = store.begin(track(), OfflineStore.AUTOMATIC, "recent", audio.length)) {
                started.write(audio, 0, audio.length);
                store.configure(opts.put("autoDownload", "off"));
                assertThrows(IOException.class, started::finish);
            }
            assertNull(store.playable(URI));
            store.configure(opts.put("autoDownload", "favorites"));
            assertNull(store.begin(track(), OfflineStore.AUTOMATIC, "recent", audio.length));
            try (OfflineStore.Capture complete = store.begin(track(), OfflineStore.AUTOMATIC, "favorites", audio.length)) {
                complete.write(audio, 0, audio.length); complete.finish();
            }
            store.configure(opts.put("autoDownload", "off"));
            assertNotNull(store.playable(URI));
            store.configure(opts.put("autoDownload", "recent"));
            store.planAutomatic("recent", new JSONArray().put("another-song"));
            assertNull(store.playable(URI));
        } finally { store.remove(new JSONArray().put("t")); }
    }
}
