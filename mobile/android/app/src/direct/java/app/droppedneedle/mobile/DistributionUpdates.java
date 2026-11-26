package app.droppedneedle.mobile;

import android.os.Build;
import com.getcapacitor.Plugin;

final class DistributionUpdates {
    static Class<? extends Plugin> plugin() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? DNUpdatesPlugin.class : DNUpdatesUnavailablePlugin.class;
    }
}
