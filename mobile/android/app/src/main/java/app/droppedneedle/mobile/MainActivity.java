package app.droppedneedle.mobile;

import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    final NotificationRoute notifications = new NotificationRoute();
    final PlaylistShortcut shortcuts = new PlaylistShortcut();
    private boolean creating;

    @Override
    public void onCreate(Bundle state) {
        notifications.restore(this, getIntent(), state);
        shortcuts.restore(getIntent(), state);
        creating = true;
        registerPlugin(DNReadPlugin.class);
        registerPlugin(DNPlayerPlugin.class);
        registerPlugin(DNLauncherPlugin.class);
        registerPlugin(DNOfflinePlugin.class);
        registerPlugin(DNPlaylistExportPlugin.class);
        registerPlugin(DNAppearancePlugin.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) registerPlugin(DNUpdatesPlugin.class);
        else registerPlugin(DNUpdatesUnavailablePlugin.class);
        super.onCreate(state);
        creating = false;
    }

    @Override protected void onNewIntent(Intent intent) {
        // BridgeActivity also dispatches the launch intent here while creating its bridge.
        if (!creating) {
            NotificationRoute.Destination destination = notifications.receive(this, intent);
            if (destination != null && getBridge() != null) {
                getBridge().triggerWindowJSEvent(destination == NotificationRoute.Destination.PLAYER
                        ? "dn-player-notification" : "dn-download-notification");
            }
        }
        if (!creating && shortcuts.receive(intent) && getBridge() != null)
            getBridge().triggerWindowJSEvent("dn-playlist-shortcut");
        super.onNewIntent(intent);
    }
    @Override public void onSaveInstanceState(Bundle state) {
        super.onSaveInstanceState(state);
        notifications.save(state);
        shortcuts.save(state);
    }
    boolean takeDownloadNotification() { return notifications.take(NotificationRoute.Destination.DOWNLOADS); }
}
