package app.droppedneedle.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import androidx.annotation.Nullable;
import com.getcapacitor.JSObject;
import java.io.IOException;
import okhttp3.HttpUrl;
import org.json.JSONException;
import org.json.JSONObject;

/** Profiles belong to an authenticated DN library account. Each actual playback opens its own selection. */
final class StreamProfiles {
    enum Path {
        WIFI("wifi"), CELLULAR("cellular"), OFFLINE("offline"), UNKNOWN("unknown");
        final String value;
        Path(String value) { this.value = value; }
    }
    interface Connection { Path read(); }

    static Path active(Context context) {
        ConnectivityManager cm = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null) return Path.UNKNOWN;
        try {
            Network network = cm.getActiveNetwork();
            if (network == null) return Path.OFFLINE;
            NetworkCapabilities caps = cm.getNetworkCapabilities(network);
            if (caps == null) return Path.UNKNOWN;
            // VPNs can include their actual underlying transports. Other available networks say
            // nothing about which connection the app's default route (and thus DN) is using.
            return classify(caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI),
                    caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET),
                    caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR),
                    caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED));
        } catch (SecurityException unavailable) {
            return Path.UNKNOWN;
        }
    }
    static Path classify(boolean wifi, boolean ethernet, boolean cellular, boolean unmetered) {
        if (cellular) return Path.CELLULAR;
        if (wifi || ethernet) return Path.WIFI;
        return unmetered ? Path.UNKNOWN : Path.CELLULAR;
    }

    static final class Quality {
        final String format;
        final int rate;
        Quality(JSONObject value) throws JSONException {
            if (value == null) throw new JSONException("Missing stream quality.");
            format = value.getString("format");
            rate = value.getInt("rate");
            if (!("original".equals(format) || "mp3".equals(format) || "opus".equals(format))
                    || !(rate == 64 || rate == 96 || rate == 128 || rate == 160 || rate == 192 || rate == 256 || rate == 320)) {
                throw new JSONException("Choose a supported audio format and bitrate.");
            }
        }
        JSONObject json() throws JSONException {
            return new JSONObject().put("format", format).put("rate", rate);
        }
        Uri apply(Uri address) {
            Uri.Builder url = address.buildUpon().clearQuery().fragment(null);
            if (!"original".equals(format)) {
                url.appendQueryParameter("format", format).appendQueryParameter("max_bitrate", Integer.toString(rate));
            }
            return url.build();
        }
    }

    private static final Object PREFERENCES = new Object();
    private final SharedPreferences prefs;
    private final String key;
    private final Connection connection;

    StreamProfiles(Context context, String address, @Nullable String userId, Connection connection) {
        HttpUrl server = HttpUrl.parse(address);
        if (server == null || !server.isHttps() || !server.username().isEmpty() || !server.password().isEmpty()
                || server.query() != null || server.fragment() != null) throw new IllegalArgumentException("Invalid DN server.");
        prefs = context.getSharedPreferences("dn.streaming.v2", Context.MODE_PRIVATE);
        key = userId == null || userId.isEmpty() ? null : server.toString().replaceAll("/+$", "") + "\n" + userId;
        this.connection = connection;
    }

    void set(JSONObject wifi, JSONObject cellular) throws JSONException {
        if (key == null) throw new IllegalArgumentException("Reconnect to DN to save streaming profiles.");
        String pair = new JSONObject().put("wifi", new Quality(wifi).json())
                .put("cellular", new Quality(cellular).json()).toString();
        synchronized (PREFERENCES) { prefs.edit().putString(key, pair).apply(); }
    }

    /** The WebView supplies pre-upgrade preferences on queue/restore. Later settings edits take precedence. */
    void migrate(@Nullable JSONObject pair) throws JSONException {
        if (key == null || pair == null) return;
        synchronized (PREFERENCES) {
            if (!prefs.contains(key)) set(pair.getJSONObject("wifi"), pair.getJSONObject("cellular"));
        }
    }

    /** Keep one representation for decoder ranges, retries and the renderer's HEAD and GET requests. */
    final class Selection {
        private Uri opened;
        private Path network;
        private String profile;
        private Uri requested;
        synchronized Uri forRequest(Uri address) throws IOException {
            if (opened != null) return opened;
            Path path = connection.read();
            network = path;
            requested = address;
            if (path == Path.OFFLINE) throw new java.net.NoRouteToHostException("Reconnect to stream this song, or choose a saved download.");
            String stored = key == null ? null : prefs.getString(key, null);
            if (stored == null) return address; // Older saved queues carry their original quality on the URI.
            try {
                JSONObject pair = new JSONObject(stored);
                profile = path == Path.WIFI ? "wifi" : "cellular";
                requested = new Quality(pair.getJSONObject(profile)).apply(address);
                return requested;
            } catch (JSONException damaged) {
                return ConversionSource.original(address);
            }
        }
        synchronized void opened(Uri representation) { opened = representation; }
        synchronized void describe(JSObject result) {
            if (network != null) result.put("network", network.value);
            if (profile != null) result.put("profile", profile);
            if (requested == null) return;
            result.put("requestedFormat", ConversionSource.requested(requested) ? requested.getQueryParameter("format") : "original");
            String rate = requested.getQueryParameter("max_bitrate");
            if (rate != null && rate.matches("[0-9]{1,3}")) result.put("requestedRate", Integer.parseInt(rate));
        }
    }

    Selection track() { return new Selection(); }

    static JSObject networkDelivery(@Nullable Selection selection, Uri representation, String ranges, boolean fallback) {
        JSObject result = new JSObject();
        result.put("source", "network");
        if (selection != null) selection.describe(result);
        if (fallback || !ConversionSource.requested(representation)
                && ("opus".equals(result.optString("requestedFormat")) || "mp3".equals(result.optString("requestedFormat"))))
            result.put("response", "fallback");
        else if (!ConversionSource.requested(representation) || "bytes".equalsIgnoreCase(ranges)) result.put("response", "original");
        else if ("none".equalsIgnoreCase(ranges)) result.put("response", "converted");
        return result;
    }

    Runnable watch(Runnable changed) {
        SharedPreferences.OnSharedPreferenceChangeListener listener = (prefs, updated) -> {
            if (key != null && key.equals(updated)) changed.run();
        };
        prefs.registerOnSharedPreferenceChangeListener(listener);
        return () -> prefs.unregisterOnSharedPreferenceChangeListener(listener);
    }
}
