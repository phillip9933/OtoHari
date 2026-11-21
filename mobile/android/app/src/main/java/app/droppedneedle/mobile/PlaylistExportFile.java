package app.droppedneedle.mobile;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import okhttp3.Call;
import okhttp3.HttpUrl;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import org.json.JSONObject;

/** A session-bound transfer. The document picker never receives this request or its credentials. */
final class PlaylistExportFile {
    private static final long MAX_BYTES = 64L * 1024 * 1024;
    private static final long SPACE_RESERVE = 32L * 1024 * 1024;
    static final class Failure extends IOException {
        final String code;
        Failure(String message, String code) {
            super(message);
            this.code = code;
        }
    }
    final String id, format, mime;
    private final File dir;
    private File staged;
    private Call request;
    private volatile boolean cancelled;
    private boolean ready;
    String disposition, skipped;

    PlaylistExportFile(File dir, String id, String format) {
        if (id == null || !UUID.fromString(id).toString().equals(id)
            || !("csv".equals(format) || "m3u8".equals(format)))
            throw new IllegalArgumentException("Choose a valid playlist export format and try again.");
        this.dir = dir;
        this.id = id;
        this.format = format;
        mime = "csv".equals(format) ? "text/csv" : "audio/x-mpegurl";
    }
    static OkHttpClient.Builder network() {
        return new OkHttpClient.Builder()
            .followRedirects(false)
            .followSslRedirects(false)
            .callTimeout(10, java.util.concurrent.TimeUnit.MINUTES)
            .readTimeout(30, java.util.concurrent.TimeUnit.SECONDS);
    }
    static HttpUrl target(String server, String url, String format) {
        HttpUrl base = server == null ? null : HttpUrl.parse(server), target = url == null ? null : HttpUrl.parse(url);
        boolean local = base != null
            && ("localhost".equals(base.host()) || "127.0.0.1".equals(base.host()) || "::1".equals(base.host()));
        if (base == null || target == null || (!base.isHttps() && !local) || !base.username().isEmpty()
            || !base.password().isEmpty() || base.query() != null || base.fragment() != null
            || !target.username().isEmpty() || !target.password().isEmpty() || !target.scheme().equals(base.scheme())
            || !target.host().equals(base.host()) || target.port() != base.port() || target.fragment() != null)
            throw invalidAddress();
        String prefix = base.encodedPath().replaceAll("/+$", "") + "/api/v3/playlists/";
        String path = target.encodedPath(), lower = path.toLowerCase(Locale.ROOT);
        List<String> segments = target.pathSegments();
        if (!path.startsWith(prefix) || !path.substring(prefix.length()).matches("[^/]+/export")
            || lower.contains("%2f") || lower.contains("%5c") || lower.contains("%2e") || segments.size() < 2
            || segments.get(segments.size() - 2).chars().anyMatch(Character::isISOControl)
            || target.queryParameterValues("format").size() != 1 || !format.equals(target.queryParameter("format"))
            || target.queryParameterValues("prefix").size() > 1
            || !target.queryParameterNames().stream().allMatch(k -> k.equals("format") || k.equals("prefix")))
            throw invalidAddress();
        return target;
    }
    private static IllegalArgumentException invalidAddress() {
        return new IllegalArgumentException("Choose a playlist on the connected DroppedNeedle server.");
    }
    void prepare(OkHttpClient client, String server, String url, String token) throws IOException {
        if (token == null || token.isEmpty())
            throw new Failure("Reconnect to DroppedNeedle before exporting.", "HTTP_401");
        Request read = new Request.Builder()
                           .url(target(server, url, format))
                           .header("Authorization", "Bearer " + token)
                           .header("Accept", mime)
                           .build();
        Call call = client.newCall(read);
        synchronized (this) {
            check();
            request = call;
        }
        try (Response r = call.execute()) {
            check();
            if (r.code() != 200) {
                String code = "HTTP_" + r.code();
                if (r.code() == 401 && mediaType(r).equals("application/json")) {
                    try {
                        JSONObject error = new JSONObject(r.peekBody(8192).string()).optJSONObject("error");
                        if (error != null && "UNAUTHORIZED".equals(error.optString("code")))
                            code = "DN_UNAUTHORIZED";
                    } catch (org.json.JSONException ignored) { /* A proxy may return its own 401. */
                    }
                }
                throw new Failure("The server could not export this playlist (" + r.code() + ").", code);
            }
            String sample = r.peekBody(256).string().trim().toLowerCase(Locale.ROOT);
            if (r.body() == null || !mime.equals(mediaType(r)) || sample.isEmpty() || sample.startsWith("<"))
                throw new Failure(
                    "DN returned a different file type. Check your server address and sign-in proxy.", "EXPORT_TYPE");
            File dest;
            synchronized (this) {
                check();
                if (!dir.isDirectory() && !dir.mkdirs())
                    throw new IOException("Could not open export staging.");
                checkBudget(0, Math.max(0, r.body().contentLength()));
                dest = File.createTempFile("playlist-", ".tmp", dir);
                staged = dest;
            }
            try (InputStream in = r.body().byteStream(); OutputStream out = new FileOutputStream(dest)) {
                transfer(in, out, true);
            }
            synchronized (this) {
                check();
                disposition = r.header("Content-Disposition");
                skipped = r.header("X-DroppedNeedle-Skipped-Tracks");
                ready = true;
            }
        } finally {
            synchronized (this) {
                request = null;
                if (!ready)
                    removeStaged();
            }
        }
    }
    synchronized boolean isReady() {
        return ready && !cancelled && staged != null;
    }
    String filename(String name) throws IOException {
        if (name == null || name.startsWith(".") || name.indexOf('/') >= 0 || name.indexOf('\\') >= 0
            || name.chars().anyMatch(Character::isISOControl) || name.getBytes(StandardCharsets.UTF_8).length > 240
            || !name.endsWith("." + format))
            throw new IOException("The export filename is invalid. Prepare the playlist again.");
        return name;
    }
    void copyTo(OutputStream out) throws IOException {
        File source;
        synchronized (this) {
            check();
            if (!isReady())
                throw new IOException("The export expired. Prepare the playlist again.");
            source = staged;
        }
        try (InputStream in = new FileInputStream(source)) {
            transfer(in, out, false);
        }
    }
    private void checkBudget(long written, long next) throws Failure {
        if (next > MAX_BYTES - written)
            throw new Failure("Playlist exports are limited to 64 MiB.", "EXPORT_TOO_LARGE");
        if (next > dir.getUsableSpace() - SPACE_RESERVE)
            throw new Failure("Free up storage before exporting this playlist.", "EXPORT_STORAGE");
    }
    private void transfer(InputStream in, OutputStream out, boolean staging) throws IOException {
        byte[] chunk = new byte[64 * 1024];
        long written = 0;
        int n;
        while ((n = in.read(chunk)) != -1) {
            check();
            if (staging) checkBudget(written, n);
            out.write(chunk, 0, n);
            written += n;
        }
        check();
        out.flush();
    }
    private static String mediaType(Response response) {
        String header = response.header("Content-Type", "");
        return header.split(";", 2)[0].trim().toLowerCase(Locale.ROOT);
    }
    private void check() throws IOException {
        if (cancelled)
            throw new Failure("Export cancelled.", "CANCELLED");
    }
    synchronized void discard() {
        cancelled = true;
        ready = false;
        if (request != null)
            request.cancel();
        removeStaged();
    }
    private void removeStaged() {
        if (staged != null) {
            staged.delete();
            staged = null;
        }
    }
    static void cleanAbandoned(File dir) {
        File[] files = dir.listFiles(f -> f.getName().startsWith("playlist-") && f.getName().endsWith(".tmp"));
        if (files != null)
            for (File file : files)
                if (file.lastModified() < System.currentTimeMillis() - 86400000L)
                    file.delete();
    }
}
