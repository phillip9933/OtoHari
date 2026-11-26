package app.droppedneedle.mobile;

import static org.junit.Assert.*;

import android.content.Context;
import android.content.pm.ProviderInfo;
import android.net.Uri;
import android.os.Build;
import androidx.core.content.FileProvider;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class DNUpdateProviderTest {
    @Test public void bridgeAndPrivateUpdateStorageFollowDeviceApi() {
        Context app = InstrumentationRegistry.getInstrumentation().getTargetContext();
        boolean supported = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O;
        try (ActivityScenario<MainActivity> screen = ActivityScenario.launch(MainActivity.class)) {
            screen.onActivity(activity -> assertEquals(
                supported ? "DNUpdatesPlugin" : "DNUpdatesUnavailablePlugin",
                activity.getBridge().getPlugin("DNUpdates").getPluginClass().getSimpleName()));
        }

        String authority = app.getPackageName() + ".android-updates";
        ProviderInfo provider = app.getPackageManager().resolveContentProvider(authority, 0);
        if (!supported) {
            assertNull(provider);
            return;
        }
        assertNotNull(provider);
        assertFalse(provider.exported);
        assertTrue(provider.grantUriPermissions);
        Uri apk = FileProvider.getUriForFile(app, authority, new File(app.getCacheDir(), "updates/synthetic.apk"));
        assertEquals(authority, apk.getAuthority());
        assertThrows(IllegalArgumentException.class, () -> FileProvider.getUriForFile(
            app, authority, new File(app.getFilesDir(), "unrelated-file")));
    }
}
