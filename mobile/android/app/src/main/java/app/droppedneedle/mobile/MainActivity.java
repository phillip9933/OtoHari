package app.droppedneedle.mobile;

import android.content.Intent;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    final NotificationRoute notifications = new NotificationRoute();
    final PlaylistShortcut shortcuts = new PlaylistShortcut();
    private boolean creating;
    private String sharedSong;
    private void receiveShare(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction()) || !"text/plain".equals(intent.getType())) return;
        CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
        if (text != null && text.length() > 0 && text.length() <= 8192) sharedSong = text.toString();
    }
    String takeSharedSong() {
        String result = sharedSong;
        sharedSong = null;
        return result;
    }

    @Override
    public void onCreate(Bundle state) {
        if (state == null) receiveShare(getIntent());
        else sharedSong = state.getString("sharedSong");
        notifications.restore(this, getIntent(), state);
        shortcuts.restore(getIntent(), state);
        creating = true;
        registerPlugin(DNReadPlugin.class);
        registerPlugin(DNPlayerPlugin.class);
        registerPlugin(DNLauncherPlugin.class);
        registerPlugin(DNOfflinePlugin.class);
        registerPlugin(DNPlaylistExportPlugin.class);
        registerPlugin(DNAppearancePlugin.class);
        Class<? extends com.getcapacitor.Plugin> updates = DistributionUpdates.plugin();
        if (updates != null) registerPlugin(updates);
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
        if (!creating && Intent.ACTION_SEND.equals(intent.getAction())) {
            receiveShare(intent);
            if (sharedSong != null && getBridge() != null) getBridge().triggerWindowJSEvent("dn-shared-song");
        }
        if (!creating && shortcuts.receive(intent) && getBridge() != null)
            getBridge().triggerWindowJSEvent("dn-playlist-shortcut");
        super.onNewIntent(intent);
    }
    @Override public void onSaveInstanceState(Bundle state) {
        super.onSaveInstanceState(state);
        notifications.save(state);
        shortcuts.save(state);
        state.putString("sharedSong", sharedSong);
    }
    boolean takeDownloadNotification() { return notifications.take(NotificationRoute.Destination.DOWNLOADS); }
}
