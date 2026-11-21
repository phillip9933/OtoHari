package app.droppedneedle.mobile;

import static org.junit.Assert.*;
import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Bundle;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.IOException;
import java.util.List;
import java.util.UUID;
import okhttp3.HttpUrl;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class CarLauncherTest {
    private final Context app = InstrumentationRegistry.getInstrumentation().getTargetContext();
    @Test public void carHostExceptionsRequireTheVerifiedOwnerOfTheControllerUid() throws Exception {
        int platformUid = app.getPackageManager().getPackageUid("android", 0);
        assertTrue(CarSession.verifiedCarHost(app, "android", platformUid, false, true));
        assertFalse(CarSession.verifiedCarHost(app, "android", platformUid, false, false));
        assertFalse(CarSession.verifiedCarHost(app, "android", app.getApplicationInfo().uid, false, true));
        assertFalse(CarSession.verifiedCarHost(app, app.getPackageName(), app.getApplicationInfo().uid, false, true));
    }
    private final HeadsetAccount owner = new HeadsetAccount(HttpUrl.get("https://car-fixture.invalid/music"), "fixture", "driver");
    @Test public void orderedHomePinsResolveTheSameMixAfterAndroidAutoReconnects() throws Exception {
        HeadsetAccount account = new HeadsetAccount(owner.server, "fixture", "pinned-fixture");
        CarHomePins pins = new CarHomePins(app, account);
        JSONObject mix = new JSONObject().put("kind", "mix").put("id", "late").put("title", "Late night")
            .put("plan", new JSONObject().put("seed_type", "items").put("items", new JSONArray().put(
                    new JSONObject().put("artist_mbid", "11111111-1111-4111-a111-111111111111"))));
        int[] plans = {0};
        CarLibrary.Read transport = new CarLibrary.Read() {
            public JSONObject get(HttpUrl url) { throw new AssertionError(url); }
            public JSONObject plan(HttpUrl url, JSONObject seed) throws JSONException {
                assertEquals("/music/api/v3/discover/radio/plan", url.encodedPath());
                assertEquals("library", seed.getString("mode"));
                plans[0]++;
                return new JSONObject().put("tracks", new JSONArray()
                    .put(new JSONObject().put("in_library", true).put("local_file_id","song").put("track_name","Starlight"))
                    .put(new JSONObject().put("in_library",false).put("track_name","External")));
            }
        };
        try {
            pins.replace(new JSONArray().put(mix).put(new JSONObject().put("kind","track").put("id","direct").put("title","A direct pin")));
            CarLibrary car = new CarLibrary(app, account, transport, false);
            List<CarLibrary.Entry> root = car.children(CarLibrary.ROOT);
            List<CarLibrary.Entry> home = car.children(root.get(root.size()-1).id);
            assertEquals("Late night", home.get(0).title);
            assertEquals("A direct pin", home.get(1).title);
            CarLibrary.Entry song = car.children(home.get(0).id).get(0);
            CarLibrary resumed = new CarLibrary(app, account, transport, false);
            assertEquals("Starlight", resumed.item(song.id).title);
            assertEquals("https://car-fixture.invalid/music/api/v3/stream/local/song", resumed.siblings(song.id).get(0).track.getString("streamUrl"));
            assertEquals(1, plans[0]);
            java.util.Map<String,JSONObject> onDevice = java.util.Collections.singletonMap("song", new JSONObject().put("id","song").put("title","Saved copy"));
            assertEquals("Saved copy", pins.offline(mix, onDevice).get(0).getString("title"));
            assertTrue(pins.offline(mix, java.util.Collections.emptyMap()).isEmpty());
            assertThrows(IOException.class, () -> new CarLibrary(app, owner, transport, false).item(song.id));
        } finally { pins.replace(new JSONArray()); }
    }
    @Test public void pinnedArtistLookupStopsWhenAContinuationCycles() throws Exception {
        CarHomePins pins = new CarHomePins(app, owner);
        JSONObject artist = new JSONObject().put("kind", "artist").put("title", "Fixture artist")
                .put("id", "11111111-1111-4111-a111-111111111111");
        int[] calls = {0};
        CarLibrary.Read pages = url -> {
            assertTrue(++calls[0] <= 3);
            return new JSONObject().put("items", new JSONArray()).put("next", calls[0] % 2 == 1 ? "one" : "two");
        };
        try {
            pins.replace(new JSONArray().put(artist));
            CarLibrary car = new CarLibrary(app, owner, pages, false);
            List<CarLibrary.Entry> root = car.children(CarLibrary.ROOT);
            String item = car.children(root.get(root.size() - 1).id).get(0).id;
            assertThrows(IOException.class, () -> car.children(item));
            assertEquals(3, calls[0]);
        } finally { pins.replace(new JSONArray()); }
    }
    @Test public void carPagesFollowDnCursorsAndSelectedTracksCanBeResolvedAfterReconnecting() throws Exception {
        CarLibrary.Read transport = url -> {
            assertEquals("car-fixture.invalid", url.host());
            String path = url.encodedPath();
            if (path.endsWith("albums")) {
                boolean second = url.queryParameter("after") != null;
                if (second) assertEquals("opaque/2+=", url.queryParameter("after"));
                return new JSONObject().put("items", new JSONArray().put(new JSONObject().put("id", second ? "b" : "a")
                        .put("title", second ? "Second album" : "First album")))
                        .put("next", second ? JSONObject.NULL : "opaque/2+=");
            }
            if (path.endsWith("/tracks")) {
                assertTrue("b".equals(url.queryParameter("album_id")) || "Night".equals(url.queryParameter("q")));
                return new JSONObject().put("items", new JSONArray().put(new JSONObject().put("id","t").put("title","Night Drive")
                        .put("artist_name","Driver").put("art_missing",true))).put("next", JSONObject.NULL);
            }
            if (path.endsWith("playlists")) return new JSONObject().put("playlists", new JSONArray()
                    .put(new JSONObject().put("id", "hidden").put("name", "Someone else's songs").put("is_redacted", true))
                    .put(new JSONObject().put("id", "p").put("name", "Mine")));
            throw new AssertionError(path);
        };
        CarLibrary car = new CarLibrary(app, owner, transport, false);
        List<CarLibrary.Entry> root = car.children(CarLibrary.ROOT);
        assertEquals(4, root.size());
        assertEquals("Mine", car.children(root.get(1).id).get(0).title);
        assertEquals(1, car.children(root.get(1).id).size());
        List<CarLibrary.Entry> albums = car.children(car.children(root.get(0).id).get(0).id);
        List<CarLibrary.Entry> second = car.children(albums.get(1).id);
        CarLibrary.Entry song = car.children(second.get(0).id).get(0);
        assertEquals("Night Drive", song.title);
        assertNull(song.media().localConfiguration);
        assertEquals("https://car-fixture.invalid/music/api/v3/stream/local/t", song.track.getString("streamUrl"));
        assertEquals("Night Drive", new CarLibrary(app, owner, transport, false).item(song.id).title);
        assertEquals("Night Drive", car.search("Night").get(0).title);
        CarLibrary next = new CarLibrary(app, new HeadsetAccount(owner.server, "other", "passenger"), url -> {
            fail("Another account's browse ID reached the network"); return null;
        }, false);
        assertThrows(IOException.class, () -> next.item(song.id));
        assertTrue(CarLibrary.slice(albums, Integer.MAX_VALUE, Integer.MAX_VALUE).isEmpty());
    }
    @Test public void shortcutHandlesAreSingleUsePerTapAndBoundToTheCurrentLibrary() throws Exception {
        String handle = UUID.randomUUID().toString();
        SharedPreferences preferences = app.getSharedPreferences("dn-launcher-playlists", Context.MODE_PRIVATE);
        preferences.edit().putString(handle, new JSONObject().put("scope", PlaylistShortcut.account(owner))
                .put("id", "smart:smart-night").toString()).commit();
        Intent launch = new Intent(app, MainActivity.class).setAction(PlaylistShortcut.ACTION).putExtra("dn.playlist.handle", handle);
        try {
            PlaylistShortcut route = new PlaylistShortcut();
            route.restore(launch, null);
            Bundle saved = new Bundle();
            route.save(saved);
            PlaylistShortcut restored = new PlaylistShortcut();
            restored.restore(null, saved);
            assertEquals("smart:smart-night", restored.take(app, owner));
            assertNull(restored.take(app, owner));
            assertTrue(restored.receive(launch));
            assertNull(restored.take(app, new HeadsetAccount(owner.server, "fixture", "passenger")));
            assertFalse(restored.receive(new Intent(launch).addFlags(Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY)));
            assertFalse(restored.receive(new Intent(launch).putExtra("dn.playlist.handle", "playlist:remote")));
        } finally { preferences.edit().remove(handle).commit(); }
    }
    @Test public void launcherAndCarExposeTheirPlatformDeclarations() throws Exception {
        PackageManager pm = app.getPackageManager();
        assertTrue(pm.getApplicationInfo(app.getPackageName(), PackageManager.GET_META_DATA).metaData
                .getInt("com.google.android.gms.car.application") != 0);
        assertTrue(pm.getServiceInfo(new ComponentName(app, PlaybackService.class),0).exported);
        android.content.pm.ActivityInfo widget = pm.getReceiverInfo(new ComponentName(app, PlayerWidget.class), PackageManager.GET_META_DATA);
        assertFalse(widget.exported);
        assertEquals(R.xml.player_widget_info, widget.metaData.getInt(AppWidgetManager.META_DATA_APPWIDGET_PROVIDER));
    }
}
