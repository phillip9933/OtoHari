package app.droppedneedle.mobile;

import android.content.Context;
import android.os.Process;
import android.os.UserManager;
import androidx.annotation.Nullable;
import com.aparajita.capacitor.securestorage.SecureStorage;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import okhttp3.HttpUrl;
import org.json.JSONException;
import org.json.JSONObject;
import org.json.JSONTokener;

/** Read the app's single active login through its installed SecureStorage plugin, without a WebView. */
final class HeadsetAccount {
    static final String SESSION_KEY = "capacitor-storage_dn.mobile.session";
    final HttpUrl server;
    final String token, userId;
    HeadsetAccount(HttpUrl server, String token, String userId) {
        this.server = server;
        this.token = token;
        this.userId = userId;
    }
    static boolean unlocked(Context context) {
        UserManager user = context.getSystemService(UserManager.class);
        // Android keeps credential-protected storage available when the listener relocks the screen.
        // A user before first unlock or a paused profile cannot supply the active DN account.
        return user != null && user.isUserUnlocked() && !user.isQuietModeEnabled(Process.myUserHandle());
    }
    @Nullable static HeadsetAccount read(Context context) {
        if (!unlocked(context)) return null;
        // The plugin supplies its own Keystore access and ciphertext format. Only its JS key
        // prefix and serialized result are needed at this native-only entry point.
        SecureStorage store = new SecureStorage() {
            @Override public Context getContext() { return context.getApplicationContext(); }
        };
        String[] result = {null};
        JSObject args = new JSObject();
        args.put("prefixedKey", SESSION_KEY);
        store.internalGetItem(new PluginCall(null, "SecureStorage", PluginCall.CALLBACK_ID_DANGLING,
                "internalGetItem", args) {
            @Override public void resolve(JSObject reply) {
                Object raw = reply.opt("data");
                if (raw instanceof String) result[0] = (String) raw;
            }
            @Override public void reject(String message, String code, Exception error, JSObject data) {
                // A missing or inaccessible key leaves the current queue alone.
            }
        });
        return storedAccount(result[0]);
    }
    @Nullable static HeadsetAccount storedAccount(String encoded) {
        if (encoded == null) return null;
        try {
            Object wrapped = new JSONTokener(encoded).nextValue();
            if (!(wrapped instanceof String)) return null;
            JSONObject stored = new JSONObject((String) wrapped);
            if (stored.has("revocations")) {
                stored = stored.optJSONObject("active");
                if (stored == null) return null;
            }
            Object address = stored.opt("serverUrl"), id = stored.opt("userId"), token = stored.opt("token");
            if (!(address instanceof String) || !(id instanceof String) || ((String) id).trim().isEmpty()
                    || !(token instanceof String) || ((String) token).isEmpty()
                    || ((String) token).chars().anyMatch(c -> c <= 32 || c > 126)) return null;
            HttpUrl server = HttpUrl.parse((String) address);
            if (server == null || !server.isHttps() || !server.username().isEmpty() || !server.password().isEmpty()
                    || server.query() != null || server.fragment() != null) return null;
            return new HeadsetAccount(server, (String) token, (String) id);
        } catch (JSONException invalid) { return null; }
    }
    boolean matches(@Nullable HeadsetAccount other) {
        return other != null && server.equals(other.server) && token.equals(other.token) && userId.equals(other.userId);
    }
}
