package app.droppedneedle.mobile;

import android.app.Instrumentation;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.media.AudioManager;
import android.os.IBinder;
import android.os.SystemClock;
import androidx.media3.common.Player;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.SilenceMediaSource;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.BooleanSupplier;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

@androidx.annotation.OptIn(markerClass = androidx.media3.common.util.UnstableApi.class)
@RunWith(AndroidJUnit4.class)
public final class PlaybackInterruptionTest {
    private final Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
    private PlaybackService playback;
    private ExoPlayer player;

    private ServiceConnection connection(CountDownLatch connected) {
        return new ServiceConnection() {
            @Override public void onServiceConnected(ComponentName name, IBinder binder) {
                playback = ((PlaybackService.LocalBinder) binder).service();
                player = (ExoPlayer) playback.output().local;
                connected.countDown();
            }
            @Override public void onServiceDisconnected(ComponentName name) {}
        };
    }

    @Test public void aTransientInterruptionPausesThePhonePlayerAndResumesTheSameTrack() throws Exception {
        Context app = instrumentation.getTargetContext();
        CountDownLatch connected = new CountDownLatch(1);
        ServiceConnection binding = connection(connected);
        AudioManager audio = (AudioManager) app.getSystemService(Context.AUDIO_SERVICE);
        AudioManager.OnAudioFocusChangeListener interruption = focus -> {};
        try (ActivityScenario<MainActivity> activity = ActivityScenario.launch(MainActivity.class)) {
            awaitAppReady(activity);
            Intent intent = new Intent(app, PlaybackService.class).setAction(PlaybackService.LOCAL_BIND);
            assertTrue(app.bindService(intent, binding, Context.BIND_AUTO_CREATE));
            try {
                assertTrue("Playback service connected", connected.await(10, TimeUnit.SECONDS));
                instrumentation.runOnMainSync(() -> {
                    // Keep the service's queue and production audio-focus configuration. Substitute
                    // a finite silent source so the interruption is independent of codecs and TLS.
                    JSObject track = new JSObject();
                    track.put("id", "focus-test");
                    track.put("title", "Interruption");
                    track.put("artist", "Test artist");
                    track.put("album", "Test album");
                    String address = "https://127.0.0.1:1";
                    track.put("streamUrl", address + "/api/v3/stream/local/focus-test");
                    try {
                        JSArray queue = new JSArray();
                        queue.put(track);
                        playback.setQueue(address, "fixture", "fixture-listener", queue, 0, null, null);
                    } catch (org.json.JSONException error) {
                        throw new AssertionError(error);
                    }
                    SilenceMediaSource.Factory source = new SilenceMediaSource.Factory().setDurationUs(120_000_000L);
                    player.setMediaSources(java.util.Arrays.asList(source.createMediaSource(), source.createMediaSource()));
                    player.prepare();
                });
                await("Track is audible", () -> player.isPlaying() && playback.snapshot().optBoolean("playing"));
                assertEquals(AudioManager.AUDIOFOCUS_REQUEST_GRANTED,
                        audio.requestAudioFocus(interruption, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT));
                await("Android suppressed playback", () -> player.getPlaybackSuppressionReason() == Player.PLAYBACK_SUPPRESSION_REASON_TRANSIENT_AUDIO_FOCUS_LOSS);
                instrumentation.runOnMainSync(() -> {
                    assertFalse("The phone must show that playback is interrupted", playback.snapshot().optBoolean("playing"));
                    assertEquals(0, playback.snapshot().optInt("index"));
                });
                audio.abandonAudioFocus(interruption);
                await("The same track resumed", () -> player.isPlaying() && playback.snapshot().optBoolean("playing") && playback.snapshot().optInt("index") == 0);
                instrumentation.runOnMainSync(() -> {
                    androidx.media3.common.MediaItem current = player.getCurrentMediaItem();
                    long before = player.getCurrentPosition();
                    assertEquals(2, player.getMediaItemCount());
                    playback.command("clearUpcoming", 0, -1);
                    assertEquals(1, player.getMediaItemCount());
                    assertSame(current, player.getCurrentMediaItem());
                    assertTrue(player.isPlaying());
                    assertTrue(player.getCurrentPosition() >= before);
                });
            } finally {
                audio.abandonAudioFocus(interruption);
                if (playback != null) instrumentation.runOnMainSync(() -> playback.command("clear", 0, -1));
                app.unbindService(binding);
            }
        }
    }

    @Test public void sleepingAtTheTrackBoundaryPausesTheServiceBeforePlayingTheNextItem() throws Exception {
        Context app = instrumentation.getTargetContext();
        CountDownLatch connected = new CountDownLatch(1);
        ServiceConnection binding = connection(connected);
        String address = "https://127.0.0.1:1";
        String listener = "sleep-" + java.util.UUID.randomUUID();
        OfflineStore files = OfflineStore.forUser(app, address, listener);
        JSArray queue = new JSArray();
        byte[] silence = OfflinePlaybackTest.wav();
        for (String id : new String[]{"first", "second"}) {
            JSObject track = new JSObject();
            track.put("id", id);
            track.put("title", id);
            track.put("artist", "Fixture artist");
            track.put("album", "Fixture record");
            track.put("streamUrl", address + "/api/v3/stream/local/" + id);
            try (OfflineStore.Capture capture = files.begin(track, true, silence.length)) {
                capture.write(silence, 0, silence.length);
                capture.finish();
            }
            queue.put(track);
        }
        try (ActivityScenario<MainActivity> activity = ActivityScenario.launch(MainActivity.class)) {
            awaitAppReady(activity);
            Intent intent = new Intent(app, PlaybackService.class).setAction(PlaybackService.LOCAL_BIND);
            assertTrue(app.bindService(intent, binding, Context.BIND_AUTO_CREATE));
            try {
                assertTrue(connected.await(10, TimeUnit.SECONDS));
                AtomicBoolean startedNext = new AtomicBoolean();
                instrumentation.runOnMainSync(() -> {
                    try {
                        playback.setQueue(address, "timer-test", listener, queue, 0, null, null);
                    } catch (org.json.JSONException error) { throw new AssertionError(error); }
                    playback.command("cycleRepeat", -1, -1);
                    assertEquals(2, playback.snapshot().optJSONArray("tracks").length());
                    player.addListener(new Player.Listener() {
                        @Override public void onEvents(Player current, Player.Events events) {
                            if (current.isPlaying() && current.getCurrentMediaItemIndex() == 1) startedNext.set(true);
                        }
                    });
                    playback.command("sleepAfterTrack", -1, -1);
                    assertTrue(player.getPauseAtEndOfMediaItems());
                    assertEquals("track", playback.snapshot().optJSONObject("sleepTimer").optString("mode"));
                });
                await("The silent track started", () -> player.isPlaying());
                await("The sleep timer paused the service", () -> !player.getPlayWhenReady() && playback.snapshot().isNull("sleepTimer"));
                instrumentation.runOnMainSync(() -> {
                    assertFalse(startedNext.get());
                    assertFalse(player.getPauseAtEndOfMediaItems());
                    assertEquals(2, player.getMediaItemCount());
                });
            } finally {
                if (playback != null) instrumentation.runOnMainSync(() -> playback.command("clear", 0, -1));
                app.unbindService(binding);
            }
        } finally {
            files.remove(new org.json.JSONArray().put("first").put("second"));
        }
    }

    @Test public void upNextPersistsDuplicatesAndResumesAlbumAfterTheNativePlayerAdvances() throws Exception {
        Context app = instrumentation.getTargetContext();
        String address = "https://127.0.0.1:1", user = "picks-" + java.util.UUID.randomUUID(), token = "picks-fixture";
        OfflineStore files = OfflineStore.forUser(app, address, user);
        byte[] silence = OfflinePlaybackTest.wav();
        JSArray album = new JSArray(), picks = new JSArray(), ids = new JSArray();
        for (String id : new String[]{"opening", "closing", "choice"}) {
            JSObject track = new JSObject();
            track.put("id", id);
            track.put("title", id);
            track.put("artist", "Artist");
            track.put("album", "Album");
            track.put("streamUrl", address + "/api/v3/stream/local/" + id);
            try (OfflineStore.Capture capture = files.begin(track, true, silence.length)) {
                capture.write(silence, 0, silence.length);
                capture.finish();
            }
            if ("choice".equals(id)) { picks.put(track); picks.put(track); }
            else album.put(track);
            ids.put(id);
        }
        CountDownLatch connected = new CountDownLatch(1);
        ServiceConnection binding = connection(connected);
        try (ActivityScenario<MainActivity> activity = ActivityScenario.launch(MainActivity.class)) {
            awaitAppReady(activity);
            assertTrue(app.bindService(new Intent(app, PlaybackService.class).setAction(PlaybackService.LOCAL_BIND),
                    binding, Context.BIND_AUTO_CREATE));
            try {
                assertTrue(connected.await(10, TimeUnit.SECONDS));
                instrumentation.runOnMainSync(() -> {
                    try {
                        playback.setQueue(address, token, user, album, 0, null, null, null, 0, false);
                        String before = playback.snapshot().getString("queueVersion");
                        JSObject tick = playback.snapshot(before);
                        assertFalse(tick.has("tracks"));
                        assertFalse(tick.has("upNext"));
                        assertEquals(0, tick.getInt("index"));
                        playback.setQueue(address, token, user, picks, 0, "upNext", null);
                        JSObject changed = playback.snapshot(before);
                        assertEquals(4, changed.getJSONArray("tracks").length());
                        assertEquals("[1,2]", changed.getJSONArray("upNext").toString());
                    } catch (org.json.JSONException e) { throw new AssertionError(e); }
                    assertEquals("closing", player.getMediaItemAt(3).mediaId);
                });
                CompletableFuture<org.json.JSONObject> stored = new CompletableFuture<>();
                new SavedQueue(app).load(SavedQueue.key(okhttp3.HttpUrl.get(address).toString(), token), stored::complete);
                assertEquals("[1,2]", stored.get(5, TimeUnit.SECONDS).getJSONArray("upNext").toString());
                instrumentation.runOnMainSync(() -> playback.command("setPlaying", 1, -1));
                await("First duplicate consumed alone", () -> player.getCurrentMediaItemIndex() == 1
                        && "[2]".equals(playback.snapshot().optJSONArray("upNext").toString()));
                await("Second duplicate consumed", () -> player.getCurrentMediaItemIndex() == 2
                        && playback.snapshot().optJSONArray("upNext").length() == 0);
                await("Album resumed after both picks", () -> player.getCurrentMediaItemIndex() == 3);
                instrumentation.runOnMainSync(() -> {
                    assertEquals("closing", playback.signalPath().optString("id"));
                    assertEquals("downloaded", playback.signalPath().optJSONObject("delivery").optString("source"));
                    player.seekTo(0, 0);
                    assertEquals(0, playback.snapshot().optJSONArray("upNext").length());
                });
            } finally {
                if (playback != null) instrumentation.runOnMainSync(() -> playback.command("clear", -1, -1));
                app.unbindService(binding);
            }
        } finally { files.remove(ids); }
    }

    @Test public void smartFadeOverlapsTwoSavedTracksOnceAndHonorsAnEndOfTrackTimer() throws Exception {
        Context app = instrumentation.getTargetContext();
        String address = "https://127.0.0.1:1", user = "fade-" + java.util.UUID.randomUUID();
        OfflineStore files = OfflineStore.forUser(app, address, user);
        files.configure(files.options().put("offlineOnly", true));
        files.recordHistory(false);
        JSArray queue = new JSArray();
        int frames = 8000 * 4;
        byte[] audio = java.util.Arrays.copyOf(OfflinePlaybackTest.wav(), 44 + 2 * frames);
        java.nio.ByteBuffer pcm = java.nio.ByteBuffer.wrap(audio).order(java.nio.ByteOrder.LITTLE_ENDIAN);
        pcm.putInt(4, 36 + 2 * frames).putInt(40, 2 * frames);
        for (String id : new String[]{"outgoing", "incoming"}) {
            JSObject track = new JSObject();
            track.put("id", id); track.put("title", id); track.put("artist", "Fixture artist");
            track.put("album", id); track.put("duration", 4);
            track.put("streamUrl", address + "/api/v3/stream/local/" + id);
            int period = "outgoing".equals(id) ? 32 : 50;
            for (int i = 0; i < frames; i++) pcm.putShort(44 + i * 2, (short) ((i % period < period / 2) ? 1 : -1));
            try (OfflineStore.Capture file = files.begin(track, true, audio.length)) {
                file.write(audio, 0, audio.length);
                file.finish();
            }
            queue.put(track);
        }
        CountDownLatch connected = new CountDownLatch(1);
        ServiceConnection binding = connection(connected);
        JSObject[] previous = new JSObject[1];
        java.util.concurrent.atomic.AtomicInteger transitions = new java.util.concurrent.atomic.AtomicInteger();
        java.util.concurrent.atomic.AtomicLong lastBoundary = new java.util.concurrent.atomic.AtomicLong();
        CompletableFuture<Long> outgoingEnd = new CompletableFuture<>();
        JSArray album = new JSArray(queue.toString());
        album.getJSONObject(0).put("albumId", "record").put("trackNumber", 1);
        album.getJSONObject(1).put("albumId", "record").put("trackNumber", 2);
        try (ActivityScenario<MainActivity> activity = ActivityScenario.launch(MainActivity.class)) {
            awaitAppReady(activity);
            assertTrue(app.bindService(new Intent(app, PlaybackService.class).setAction(PlaybackService.LOCAL_BIND),
                    binding, Context.BIND_AUTO_CREATE));
            try {
                assertTrue(connected.await(10, TimeUnit.SECONDS));
                instrumentation.runOnMainSync(() -> {
                    previous[0] = playback.fades().settings();
                    playback.fades().configure(0, 0, true);
                    player.addListener(new Player.Listener() {
                        @Override public void onPositionDiscontinuity(Player.PositionInfo old, Player.PositionInfo current, int reason) {
                            if (old.mediaItem != null && current.mediaItem != null && old.mediaItem.mediaId.equals("outgoing")
                                    && current.mediaItem.mediaId.equals("incoming")) {
                                transitions.incrementAndGet();
                                lastBoundary.set(old.positionMs);
                                outgoingEnd.complete(old.positionMs);
                            }
                        }
                    });
                    try { playback.setQueue(address, "fixture", user, queue, 0, null, null); }
                    catch (org.json.JSONException malformed) { throw new AssertionError(malformed); }
                });
                activity.moveToState(androidx.lifecycle.Lifecycle.State.CREATED);
                // Both 4 s sources are quiet: the two-second cap starts song two halfway through song one.
                long handoff = outgoingEnd.get(8, TimeUnit.SECONDS);
                assertTrue("Overlap starts near 2000 ms, got " + handoff, handoff > 1800 && handoff < 2300);
                await("Incoming source is audible while the outgoing PCM deck is still running",
                        () -> player.isPlaying() && player.getCurrentMediaItemIndex() == 1
                                && player.getVolume() > .12f && player.getVolume() < .7f);
                await("The second source finishes its equal-power transition",
                        () -> player.getVolume() > .96f && player.getCurrentPosition() < 2600);
                instrumentation.runOnMainSync(() -> {
                    assertEquals(1, transitions.get());
                    assertEquals(2, playback.snapshot().optJSONArray("tracks").length());
                    try { playback.setQueue(address, "fixture", user, queue, 0, null, null); }
                    catch (org.json.JSONException malformed) { throw new AssertionError(malformed); }
                    playback.command("sleepAfterTrack", 1, -1);
                });
                await("Sleep reaches the outgoing song's own end",
                        () -> !player.getPlayWhenReady() && playback.snapshot().isNull("sleepTimer"));
                assertEquals("Sleep prevented an early handoff", 1, transitions.get());
                instrumentation.runOnMainSync(() -> {
                    playback.fades().configure(500, 8000, true);
                    try { playback.setQueue(address, "fixture", user, album, 0, null, null); }
                    catch (org.json.JSONException malformed) { throw new AssertionError(malformed); }
                });
                await("The album's outgoing tail keeps full level", () -> player.getCurrentMediaItemIndex() == 0
                        && player.getCurrentPosition() > 3200 && player.getVolume() > .99f);
                await("The next album track starts at full level", () -> player.getCurrentMediaItemIndex() == 1
                        && player.isPlaying() && player.getCurrentPosition() < 180 && player.getVolume() > .95f);
                assertTrue("Album tracks advance at the end", lastBoundary.get() > 3800);
                instrumentation.runOnMainSync(() -> {
                    playback.fades().configure(0, 0, true);
                    try { playback.setQueue(address, "fixture", user, queue, 0, null, null); }
                    catch (org.json.JSONException malformed) { throw new AssertionError(malformed); }
                });
                await("Both decks are running before a manual seek", () -> player.getCurrentMediaItemIndex() == 1
                        && player.getVolume() > .1f && player.getVolume() < .75f);
                instrumentation.runOnMainSync(() -> playback.command("seek", 3, -1));
                await("Seeking dismisses the outgoing tail", () -> player.getCurrentPosition() >= 3000 && player.getVolume() == 1);
                instrumentation.runOnMainSync(() -> {
                    try { playback.setQueue(address, "fixture", user, queue, 0, null, null); }
                    catch (org.json.JSONException malformed) { throw new AssertionError(malformed); }
                });
                await("The last queue is playing", () -> player.getCurrentMediaItemIndex() == 0 && player.getCurrentPosition() > 350);
                instrumentation.runOnMainSync(() -> playback.command("clearUpcoming", 0, -1));
                await("Removing the upcoming song cancels its planned transition", () -> player.getCurrentMediaItemIndex() == 0
                        && player.getMediaItemCount() == 1 && player.getCurrentPosition() > 2700 && player.getVolume() == 1);
            } finally {
                if (playback != null) instrumentation.runOnMainSync(() -> {
                    playback.command("clear", 0, -1);
                    if (previous[0] != null) playback.fades().configure(previous[0].optInt("fadeInMs"),
                            previous[0].optInt("fadeOutMs"), previous[0].optBoolean("smart"));
                });
                app.unbindService(binding);
            }
        } finally { files.remove(new org.json.JSONArray().put("outgoing").put("incoming")); }
    }

    @Test public void libraryRefillReachesExoPlayerAndAnExplicitAppendPreservesDuplicates() throws Exception {
        Context app = instrumentation.getTargetContext();
        String address = "https://127.0.0.1:1";
        String listener = "library-" + java.util.UUID.randomUUID(), token = "queue-fixture";
        OfflineStore files = OfflineStore.forUser(app, address, listener);
        JSArray queue = new JSArray();
        org.json.JSONArray ids = new org.json.JSONArray();
        byte[] silence = OfflinePlaybackTest.wav();
        for (int i = 0; i < 62; i++) {
            String id = "s" + i;
            JSObject track = new JSObject();
            track.put("id", id); track.put("title", id); track.put("artist", "Test"); track.put("album", "Album");
            track.put("streamUrl", address + "/api/v3/stream/local/" + id);
            if (i < 60) queue.put(track);
            if (i >= 59) {
                try (OfflineStore.Capture capture = files.begin(track, true, silence.length)) {
                    capture.write(silence, 0, silence.length);
                    capture.finish();
                }
                ids.put(id);
            }
        }
        org.json.JSONObject continuation = new org.json.JSONObject()
                .put("filters", new org.json.JSONObject().put("sort", "random").put("order", "asc"))
                .put("loaded", 76_001).put("total", 76_003).put("after", "random+ordered/seed&cursor=60");
        org.json.JSONArray incoming = new org.json.JSONArray();
        for (int i = 60; i < 62; i++) incoming.put(new org.json.JSONObject()
                .put("id", "s" + i).put("title", "s" + i).put("artist_name", "Test").put("album_title", "Album"));
        String page = new org.json.JSONObject().put("total", 76_003).put("next", org.json.JSONObject.NULL)
                .put("items", incoming).toString();
        CountDownLatch requested = new CountDownLatch(1), release = new CountDownLatch(1);
        java.util.concurrent.atomic.AtomicReference<okhttp3.Request> request = new java.util.concurrent.atomic.AtomicReference<>();
        okhttp3.OkHttpClient synthetic = new okhttp3.OkHttpClient.Builder().addInterceptor(chain -> {
            request.set(chain.request());
            requested.countDown();
            try { if (!release.await(10, TimeUnit.SECONDS)) throw new java.io.IOException("Fixture timed out."); }
            catch (InterruptedException interrupted) { throw new java.io.IOException(interrupted); }
            return new okhttp3.Response.Builder().request(chain.request()).protocol(okhttp3.Protocol.HTTP_1_1)
                    .code(200).message("Fixture").body(okhttp3.ResponseBody.create(
                            okhttp3.MediaType.get("application/json"), page)).build();
        }).build();
        CountDownLatch connected = new CountDownLatch(1);
        ServiceConnection binding = connection(connected);
        try (ActivityScenario<MainActivity> activity = ActivityScenario.launch(MainActivity.class)) {
            awaitAppReady(activity);
            Intent intent = new Intent(app, PlaybackService.class).setAction(PlaybackService.LOCAL_BIND);
            assertTrue(app.bindService(intent, binding, Context.BIND_AUTO_CREATE));
            try {
                assertTrue(connected.await(10, TimeUnit.SECONDS));
                AtomicBoolean heardNewTrack = new AtomicBoolean();
                instrumentation.runOnMainSync(() -> {
                    try {
                        // Substitute only the unexported pager's transport in this instrumented process.
                        // Its production host/dispatcher still mutate the real service queue on the player thread.
                        java.lang.reflect.Field holder = PlaybackService.class.getDeclaredField("pager");
                        java.lang.reflect.Field host = LibraryQueuePager.class.getDeclaredField("host");
                        java.lang.reflect.Field dispatch = LibraryQueuePager.class.getDeclaredField("main");
                        holder.setAccessible(true); host.setAccessible(true); dispatch.setAccessible(true);
                        LibraryQueuePager original = (LibraryQueuePager) holder.get(playback);
                        holder.set(playback, new LibraryQueuePager((LibraryQueuePager.Host) host.get(original),
                                (LibraryQueuePager.Dispatch) dispatch.get(original), synthetic));
                        player.addListener(new Player.Listener() {
                            @Override public void onEvents(Player source, Player.Events events) {
                                androidx.media3.common.MediaItem item = source.getCurrentMediaItem();
                                if (source.isPlaying() && item != null && "s60".equals(item.mediaId)) heardNewTrack.set(true);
                            }
                        });
                        playback.setQueue(address, token, listener, queue, 59, null, null, continuation);
                    } catch (ReflectiveOperationException | org.json.JSONException error) { throw new AssertionError(error); }
                });
                assertTrue(requested.await(5, TimeUnit.SECONDS));
                assertEquals("Bearer " + token, request.get().header("Authorization"));
                assertEquals("/api/v3/library/tracks", request.get().url().encodedPath());
                assertEquals("random+ordered/seed&cursor=60", request.get().url().queryParameter("after"));
                assertEquals("random", request.get().url().queryParameter("sort"));
                await("First WAV reached the end while DN's next page is delayed", () ->
                        player.getPlaybackState() == Player.STATE_ENDED && playback.snapshot().optBoolean("playing"));
                release.countDown();
                await("A native page brought the next WAV to playing ExoPlayer", heardNewTrack::get);
                CompletableFuture<org.json.JSONObject> encrypted = new CompletableFuture<>();
                new SavedQueue(app).load(SavedQueue.key(okhttp3.HttpUrl.get(address).toString(), token), encrypted::complete);
                org.json.JSONObject saved = encrypted.get(5, TimeUnit.SECONDS);
                assertNotNull(saved);
                assertEquals(76_003, saved.getJSONObject("continuation").getInt("loaded"));
                assertTrue(saved.getJSONObject("continuation").isNull("after"));
                assertEquals(53, saved.getJSONArray("tracks").length());
                instrumentation.runOnMainSync(() -> {
                    try {
                        JSObject state = playback.snapshot();
                        assertEquals(53, state.optJSONArray("tracks").length());
                        assertEquals(75_950, state.optJSONObject("libraryWindow").optInt("offset"));
                        assertFalse(state.optJSONObject("libraryWindow").optBoolean("more"));
                        assertEquals("s9", player.getMediaItemAt(0).mediaId);
                        JSArray one = new JSArray(); one.put(queue.getJSONObject(59));
                        playback.setQueue(address, token, listener, one, 0, "end", null);
                        assertEquals(54, player.getMediaItemCount());
                        assertEquals("s59", player.getMediaItemAt(50).mediaId);
                        assertEquals("s59", player.getMediaItemAt(53).mediaId);
                        assertTrue(playback.snapshot().isNull("libraryWindow"));
                    } catch (org.json.JSONException error) { throw new AssertionError(error); }
                });
            } finally {
                release.countDown();
                if (playback != null) instrumentation.runOnMainSync(() -> playback.command("clear", -1, -1));
                app.unbindService(binding);
            }
        } finally {
            files.remove(ids);
            synthetic.dispatcher().executorService().shutdownNow();
        }
    }

    @Test
    public void naturalEndContinuesWithLibraryRadioAndRespectsAnExplicitPause() throws Exception {
        Context app = instrumentation.getTargetContext();
        String address = "https://127.0.0.1:1", user = "radio-" + java.util.UUID.randomUUID();
        OfflineStore files = OfflineStore.forUser(app, address, user);
        byte[] silence = OfflinePlaybackTest.wav();
        JSArray first = new JSArray();
        org.json.JSONArray ids = new org.json.JSONArray();
        for (String id : new String[] {"first", "second"}) {
            JSObject track = new JSObject();
            track.put("id", id);
            track.put("title", id);
            track.put("artist", "Fixture");
            track.put("album", "Studio");
            track.put("genre", "Jazz");
            track.put("streamUrl", address + "/api/v3/stream/local/" + id);
            if (id.equals("first"))
                first.put(track);
            try (OfflineStore.Capture capture = files.begin(track, true, silence.length)) {
                capture.write(silence, 0, silence.length);
                capture.finish();
            }
            ids.put(id);
        }
        CountDownLatch planned = new CountDownLatch(1), delayed = new CountDownLatch(1),
                       release = new CountDownLatch(1);
        java.util.concurrent.atomic.AtomicInteger calls = new java.util.concurrent.atomic.AtomicInteger();
        org.json.JSONObject added = new org.json.JSONObject()
                                            .put("in_library", true)
                                            .put("local_file_id", "second")
                                            .put("artist_mbid", "11111111-1111-1111-1111-111111111111")
                                            .put("track_name", "Second")
                                            .put("artist_name", "Fixture");
        String payload = new org.json.JSONObject().put("tracks", new org.json.JSONArray().put(added)).toString();
        okhttp3.OkHttpClient synthetic =
                new okhttp3.OkHttpClient.Builder()
                        .addInterceptor(chain -> {
                            if (calls.incrementAndGet() == 1)
                                planned.countDown();
                            else {
                                delayed.countDown();
                                try {
                                    if (!release.await(10, TimeUnit.SECONDS))
                                        throw new java.io.IOException("Fixture timed out.");
                                } catch (InterruptedException e) {
                                    throw new java.io.IOException(e);
                                }
                            }
                            return new okhttp3.Response.Builder()
                                    .request(chain.request())
                                    .protocol(okhttp3.Protocol.HTTP_1_1)
                                    .code(200)
                                    .message("Fixture")
                                    .body(okhttp3.ResponseBody.create(
                                            okhttp3.MediaType.get("application/json"), payload))
                                    .build();
                        })
                        .build();
        CountDownLatch connected = new CountDownLatch(1);
        ServiceConnection binding = connection(connected);
        java.lang.reflect.Field client = PlaybackService.class.getDeclaredField("playbackHttp");
        client.setAccessible(true);
        java.lang.reflect.Field path = PlaybackService.class.getDeclaredField("playbackNetwork");
        path.setAccessible(true);
        java.util.concurrent.atomic.AtomicReference<StreamProfiles.Path> originalPath =
                new java.util.concurrent.atomic.AtomicReference<>();
        java.util.concurrent.atomic.AtomicReference<okhttp3.OkHttpClient> original =
                new java.util.concurrent.atomic.AtomicReference<>();
        try (ActivityScenario<MainActivity> activity = ActivityScenario.launch(MainActivity.class)) {
            awaitAppReady(activity);
            assertTrue(
                    app.bindService(new Intent(app, PlaybackService.class).setAction(PlaybackService.LOCAL_BIND),
                            binding, Context.BIND_AUTO_CREATE));
            try {
                assertTrue(connected.await(10, TimeUnit.SECONDS));
                instrumentation.runOnMainSync(() -> {
                    try {
                        original.set((okhttp3.OkHttpClient) client.get(playback));
                        client.set(playback, synthetic);
                        // A synthetic DN server, like the cached audio, is available even on an isolated emulator.
                        originalPath.set((StreamProfiles.Path) path.get(playback));
                        path.set(playback, StreamProfiles.Path.WIFI);
                        playback.autoplaySetting(address, user, true);
                        playback.setQueue(address, "fixture", user, first, 0, null, null);
                    } catch (Exception e) {
                        throw new AssertionError(e);
                    }
                });
                assertTrue("The service requested its first radio plan at natural end",
                        planned.await(10, TimeUnit.SECONDS));
                assertTrue("The recommended cached WAV played through to its end",
                        delayed.await(10, TimeUnit.SECONDS));
                instrumentation.runOnMainSync(() -> {
                    assertEquals(1, player.getCurrentMediaItemIndex());
                    assertEquals("second", player.getCurrentMediaItem().mediaId);
                    assertTrue(playback.snapshot().optBoolean("playing"));
                    playback.command("setPlaying", 0, -1);
                    assertFalse(playback.snapshot().optBoolean("playing"));
                });
                release.countDown();
                instrumentation.waitForIdleSync();
                instrumentation.runOnMainSync(() -> assertFalse(player.getPlayWhenReady()));
            } finally {
                release.countDown();
                if (playback != null)
                    instrumentation.runOnMainSync(() -> {
                        playback.autoplaySetting(address, user, false);
                        playback.command("clear", -1, -1);
                        try {
                            if (original.get() != null)
                                client.set(playback, original.get());
                            if (originalPath.get() != null)
                                path.set(playback, originalPath.get());
                        } catch (IllegalAccessException e) {
                            throw new AssertionError(e);
                        }
                    });
                app.unbindService(binding);
            }
        } finally {
            release.countDown();
            files.remove(ids);
            synthetic.dispatcher().executorService().shutdownNow();
        }
    }

    @Test
    public void restoringAReplacedPausedQueueKeepsItsCursorShuffleAndAccount() throws Exception {
        Context app = instrumentation.getTargetContext();
        String address = "https://127.0.0.1:1";
        JSArray tracks = new JSArray(), replacement = new JSArray();
        for (int i = 0; i < 5; i++) {
            String id = i == 2 ? "s0" : "s" + i;
            JSObject row = new JSObject();
            row.put("id", id);
            row.put("title", "Occurrence " + i);
            row.put("album", "Album");
            row.put("artist", "Fixture");
            row.put("streamUrl", address + "/api/v3/stream/local/" + id);
            tracks.put(row);
            if (i == 0)
                replacement.put(row);
        }
        CountDownLatch connected = new CountDownLatch(1);
        ServiceConnection binding = connection(connected);
        try (ActivityScenario<MainActivity> activity = ActivityScenario.launch(MainActivity.class)) {
            awaitAppReady(activity);
            assertTrue(
                    app.bindService(new Intent(app, PlaybackService.class).setAction(PlaybackService.LOCAL_BIND),
                            binding, Context.BIND_AUTO_CREATE));
            try {
                assertTrue(connected.await(10, TimeUnit.SECONDS));
                instrumentation.runOnMainSync(() -> {
                    try {
                        playback.setQueue(address, "timer-fixture", "A", tracks, 2, null, null, null, 3.5, false);
                        playback.command("shuffleUpcoming", 0, -1);
                        playback.setQueue(
                                address, "timer-fixture", "A", replacement, 0, null, null, null, 0, false);
                        assertTrue(playback.snapshot().optBoolean("hasPreviousQueue"));
                        playback.command("restorePreviousQueue", 0, -1);
                        assertEquals("s0", player.getCurrentMediaItem().mediaId);
                        assertEquals(2, player.getCurrentMediaItemIndex());
                        assertEquals(3500, player.getCurrentPosition());
                        assertFalse(player.getPlayWhenReady());
                        assertTrue(playback.snapshot().optBoolean("shuffled"));
                        playback.setQueue(
                                address, "timer-fixture", "B", replacement, 0, null, null, null, 0, false);
                        assertFalse(playback.snapshot().optBoolean("hasPreviousQueue"));
                    } catch (org.json.JSONException error) {
                        throw new AssertionError(error);
                    }
                });
            } finally {
                if (playback != null)
                    instrumentation.runOnMainSync(() -> playback.command("clear", -1, -1));
                app.unbindService(binding);
            }
        }
    }

    // Startup intentionally clears orphaned playback before rendering the signed-out form.
    private void awaitAppReady(ActivityScenario<MainActivity> activity) throws Exception {
        long end = SystemClock.elapsedRealtime() + 10_000;
        do {
            CompletableFuture<Boolean> ready = new CompletableFuture<>();
            activity.onActivity(a -> a.getBridge().getWebView().evaluateJavascript(
                    "Boolean(document.querySelector('main form, nav[aria-label=Music]'))",
                    value -> ready.complete("true".equals(value))));
            if (ready.get(2, TimeUnit.SECONDS)) return;
            SystemClock.sleep(50);
        } while (SystemClock.elapsedRealtime() < end);
        fail("The application did not finish restoring its session.");
    }

    private void await(String description, BooleanSupplier condition) {
        long end = SystemClock.elapsedRealtime() + 10_000;
        AtomicBoolean satisfied = new AtomicBoolean();
        do {
            instrumentation.runOnMainSync(() -> satisfied.set(condition.getAsBoolean()));
            if (satisfied.get()) return;
            SystemClock.sleep(25);
        } while (SystemClock.elapsedRealtime() < end);
        fail(description);
    }
}
