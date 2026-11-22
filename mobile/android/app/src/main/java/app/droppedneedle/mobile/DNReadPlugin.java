package app.droppedneedle.mobile;

import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.HttpUrl;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;

@CapacitorPlugin(name = "DNRead")
public class DNReadPlugin extends Plugin {
    private static final OkHttpClient HTTP = new OkHttpClient.Builder()
        .followRedirects(false).followSslRedirects(false).callTimeout(30, TimeUnit.SECONDS).build();
    private final ConcurrentHashMap<String, Call> active = new ConcurrentHashMap<>();

    @PluginMethod public void read(PluginCall bridge) {
        String id = bridge.getString("id"), kind = bridge.getString("kind", "");
        try {
            if (!UUID.fromString(id).toString().equals(id)) throw new IllegalArgumentException();
            String token = bridge.getString("token", "");
            HttpUrl base = HttpUrl.get(bridge.getString("server", ""));
            HttpUrl url = HttpUrl.get(bridge.getString("url", ""));
            String prefix = base.encodedPath().replaceFirst("/+$", "") + "/api/v3/";
            if (token.isEmpty() || !base.username().isEmpty() || !base.password().isEmpty()
                || base.query() != null || base.fragment() != null || !url.username().isEmpty()
                || !url.password().isEmpty() || url.fragment() != null || !url.encodedPath().startsWith(prefix)
                || !base.host().equals(url.host()) || base.port() != url.port() || !base.scheme().equals(url.scheme())
                || url.encodedPath().toLowerCase(Locale.ROOT).matches(".*%(2e|2f|5c).*")
                || (!base.isHttps() && !base.host().matches("localhost|127\\.0\\.0\\.1|::1"))) throw new IllegalArgumentException();
            String accept;
            switch (kind) {
                case "artwork": accept = "image/*"; break;
                case "search": accept = "application/json"; break;
                case "preview": accept = "audio/*, application/octet-stream"; break;
                default: throw new IllegalArgumentException();
            }
            Request.Builder request = new Request.Builder().url(url).header("Authorization", "Bearer " + token).header("Accept", accept);
            if (kind.equals("preview")) request.header("Range", "bytes=0-2097151");
            Call call = HTTP.newCall(request.build());
            if (active.putIfAbsent(id, call) != null) throw new IllegalArgumentException();
            call.enqueue(new Callback() {
                public void onFailure(Call ignored, IOException error) {
                    active.remove(id, call);
                    bridge.reject("Could not finish the DroppedNeedle request.");
                }
                public void onResponse(Call ignored, Response response) {
                    try (Response closed = response) {
                        String mime = response.header("Content-Type", "").split(";", 2)[0].trim().toLowerCase(Locale.ROOT);
                        boolean ok = response.isSuccessful();
                        JSObject result = new JSObject().put("status", response.code()).put("type", mime);
                        boolean warming = kind.equals("artwork") && response.code() == 202;
                        if (!warming && (ok || mime.equals("application/json"))) {
                            boolean text = !ok || kind.equals("search");
                            int limit = !ok ? 32768 : kind.equals("preview") ? 2097152 : 8388608;
                            if (ok && (response.code() != (kind.equals("preview") ? 206 : 200)
                                || (kind.equals("artwork") && !mime.matches("image/(jpeg|png|webp|avif|gif)"))
                                || (kind.equals("search") && !mime.equals("application/json"))
                                || (kind.equals("preview") && !(mime.startsWith("audio/") || mime.matches("application/(octet-stream|ogg|flac)")))))
                                throw new IOException();
                            if (response.body() == null || response.body().contentLength() > limit) throw new IOException();
                            byte[] bytes = readLimited(response.body().byteStream(), limit);
                            result.put("data", text ? new String(bytes, StandardCharsets.UTF_8) : Base64.encodeToString(bytes, Base64.NO_WRAP));
                        }
                        bridge.resolve(result);
                    } catch (IOException error) {
                        bridge.reject("The server returned an unsupported or oversized response.");
                    } finally {
                        active.remove(id, call);
                    }
                }
            });
        } catch (RuntimeException invalid) {
            bridge.reject("Invalid DroppedNeedle read.");
        }
    }

    static byte[] readLimited(InputStream stream, int limit) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[16384];
        for (int n; (n = stream.read(buffer)) != -1;) {
            if (n > limit - output.size()) throw new IOException("Response exceeds its size limit.");
            output.write(buffer, 0, n);
        }
        return output.toByteArray();
    }

    @PluginMethod public void cancel(PluginCall bridge) {
        Call call = active.get(bridge.getString("id", ""));
        if (call != null) call.cancel();
        bridge.resolve();
    }

    @Override protected void handleOnDestroy() {
        for (Call call : active.values()) call.cancel();
        super.handleOnDestroy();
    }
}
