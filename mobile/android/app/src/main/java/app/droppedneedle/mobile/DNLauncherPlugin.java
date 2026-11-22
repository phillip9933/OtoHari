package app.droppedneedle.mobile;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "DNLauncher")
public class DNLauncherPlugin extends Plugin {
    private HeadsetAccount current(PluginCall call) {
        HeadsetAccount owner = HeadsetAccount.read(getContext());
        okhttp3.HttpUrl server = okhttp3.HttpUrl.parse(call.getString("serverUrl", ""));
        if (owner != null && owner.server.equals(server) && owner.userId.equals(call.getString("userId"))) return owner;
        return null;
    }
    @PluginMethod public void takePlayerNotification(PluginCall call) {
        boolean open = getActivity() instanceof MainActivity activity
                && activity.notifications.take(NotificationRoute.Destination.PLAYER);
        call.resolve(new JSObject().put("open", open));
    }
    @PluginMethod public void pinPlaylist(PluginCall call) {
        HeadsetAccount owner = current(call);
        if (owner == null) { call.reject("Sign into DroppedNeedle first."); return; }
        try {
            if (!PlaylistShortcut.pin(getActivity(), owner, call.getString("id"), call.getString("name")))
                call.reject("This launcher could not pin the playlist.");
            else call.resolve();
        } catch (Exception invalid) { call.reject("Could not pin this playlist."); }
    }
    @PluginMethod public void takePlaylist(PluginCall call) {
        HeadsetAccount owner = current(call);
        JSObject reply = new JSObject();
        if (owner != null) reply.put("id", ((MainActivity)getActivity()).shortcuts.take(getContext(), owner));
        call.resolve(reply);
    }
    @PluginMethod public void replaceHomePins(PluginCall call) {
        HeadsetAccount owner = current(call);
        if (owner == null) { call.reject("Sign into DroppedNeedle first."); return; }
        try {
            new CarHomePins(getContext(), owner).replace(call.getArray("pins"));
            call.resolve();
        } catch (org.json.JSONException invalid) { call.reject("Invalid Home pins."); }
    }
}
