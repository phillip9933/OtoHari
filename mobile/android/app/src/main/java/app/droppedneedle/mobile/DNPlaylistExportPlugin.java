package app.droppedneedle.mobile;

import android.app.Activity;
import android.content.Context;
import android.content.pm.PackageManager;
import android.content.pm.ProviderInfo;
import android.os.Process;
import android.provider.DocumentsContract;
import android.content.Intent;
import android.net.Uri;
import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import okhttp3.OkHttpClient;

@CapacitorPlugin(name = "DNPlaylistExport")
public final class DNPlaylistExportPlugin extends Plugin {
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final OkHttpClient http = PlaylistExportFile.network().build();
    private File dir;
    private PlaylistExportFile active;
    private boolean picking;
    private CancellationSignal writing;

    @Override
    public void load() {
        dir = new File(getContext().getCacheDir(), "playlist-exports");
        io.execute(() -> PlaylistExportFile.cleanAbandoned(dir));
    }
    @PluginMethod
    public synchronized void prepare(PluginCall call) {
        if (active != null || picking || writing != null) {
            call.reject("Finish or cancel the open export before starting another.");
            return;
        }
        final PlaylistExportFile file;
        try {
            file = new PlaylistExportFile(dir, call.getString("id"), call.getString("format"));
        } catch (IllegalArgumentException e) {
            call.reject("Choose a valid playlist export and try again.");
            return;
        }
        active = file;
        io.execute(() -> {
            try {
                file.prepare(http, call.getString("serverUrl"), call.getString("url"), call.getString("token"));
                JSObject result = new JSObject();
                if (file.disposition != null)
                    result.put("contentDisposition", file.disposition);
                if (file.skipped != null)
                    result.put("skippedTracks", file.skipped);
                call.resolve(result);
            } catch (Exception e) {
                finish(file);
                if (e instanceof PlaylistExportFile.Failure problem)
                    call.reject(problem.getMessage(), problem.code);
                else if (e instanceof IllegalArgumentException)
                    call.reject("Invalid export address or session. Reconnect to DroppedNeedle.");
                else
                    call.reject("Could not prepare the playlist. Check the DN connection and available device storage, "
                                + "then try again.");
            }
        });
    }
    static Intent destination(String mime, String filename) {
        return new Intent(Intent.ACTION_CREATE_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType(mime)
            .putExtra(Intent.EXTRA_TITLE, filename);
    }
    @PluginMethod
    public synchronized void save(PluginCall call) {
        final PlaylistExportFile file = lookup(call);
        if (file == null || !file.isReady()) {
            call.reject("The prepared file expired. Prepare the playlist again.");
            return;
        }
        if (picking || writing != null) {
            call.reject("Close the open Files picker and try again.");
            return;
        }
        final String name;
        try {
            name = file.filename(call.getString("filename"));
        } catch (IOException e) {
            call.reject(e.getMessage());
            return;
        }
        chooseDocument(call, file.mime, name, file);
    }

    static final String LAYOUT_NAME = "droppedneedle-player-layout.json";
    private static final int MAX_LAYOUT_BYTES = 64 * 1024;
    static byte[] layoutBytes(String text) throws IOException {
        if (text == null || text.isEmpty()) throw new IOException("No layout is available to save.");
        if (text.length() > MAX_LAYOUT_BYTES)
            throw new IOException("Use a layout no larger than 64 KiB.");
        byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MAX_LAYOUT_BYTES) throw new IOException("Use a layout no larger than 64 KiB.");
        return bytes;
    }

    @PluginMethod
    public synchronized void saveLayout(PluginCall call) {
        if (active != null || picking || writing != null) {
            call.reject("Finish the open export and try again.");
            return;
        }
        try {
            layoutBytes(call.getString("text"));
        } catch (IOException invalid) {
            call.reject(invalid.getMessage());
            return;
        }
        chooseDocument(call, "application/json", LAYOUT_NAME, null);
    }

    private void chooseDocument(PluginCall call, String mime, String name, PlaylistExportFile file) {
        picking = true;
        getActivity().runOnUiThread(() -> {
            synchronized (this) {
                if (active != file) {
                    picking = false;
                    call.reject("Export cancelled.");
                    return;
                }
            }
            try {
                startActivityForResult(call, destination(mime, name), "documentChosen");
            } catch (RuntimeException e) {
                synchronized (this) {
                    picking = false;
                }
                finish(file);
                call.reject("No document picker could open. Enable a Files provider and try again.");
            }
        });
    }
    @ActivityCallback
    synchronized void documentChosen(PluginCall call, ActivityResult result) {
        picking = false;
        if (call == null)
            return;
        boolean layout = "saveLayout".equals(call.getMethodName());
        PlaylistExportFile file = layout ? null : lookup(call);
        if (result.getResultCode() == Activity.RESULT_CANCELED) {
            finish(file);
            call.resolve(new JSObject().put("saved", false));
            return;
        }
        if (!layout && (file == null || !file.isReady())) {
            call.reject("The prepared export expired. Reopen the playlist and try again.");
            return;
        }
        Uri uri = result.getData() == null ? null : result.getData().getData();
        if (result.getResultCode() != Activity.RESULT_OK || uri == null || !"content".equals(uri.getScheme())) {
            finish(file);
            call.reject("Files did not return a writable document. Choose another destination.");
            return;
        }
        CancellationSignal signal = new CancellationSignal();
        writing = signal;
        io.execute(() -> {
            try {
                DocumentContent content;
                if (layout) {
                    byte[] bytes = layoutBytes(call.getString("text"));
                    content = out -> out.write(bytes);
                } else {
                    content = file::copyTo;
                }
                writeDocument(getContext(), uri, result.getData().getFlags(), signal, content);
                finish(file);
                call.resolve(new JSObject().put("saved", true));
            } catch (Exception e) {
                finish(file);
                call.reject("Could not finish writing the " + (layout ? "layout" : "playlist")
                            + ". Check the destination for an incomplete file, then "
                            + "choose a writable location with sufficient space.");
            } finally {
                synchronized (this) {
                    if (writing == signal)
                        writing = null;
                }
            }
        });
    }
    interface DocumentContent { void write(OutputStream output) throws IOException; }
    static boolean writableDocument(Context context, Uri uri, int flags) {
        if (uri == null || !"content".equals(uri.getScheme()) || uri.getAuthority() == null
            || (flags & Intent.FLAG_GRANT_WRITE_URI_PERMISSION) == 0) return false;
        ProviderInfo provider = context.getPackageManager().resolveContentProvider(uri.getAuthority(), 0);
        return provider != null && provider.applicationInfo != null && provider.applicationInfo.uid != Process.myUid()
            && DocumentsContract.isDocumentUri(context, uri)
            && context.checkUriPermission(uri, Process.myPid(), Process.myUid(), Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
                == PackageManager.PERMISSION_GRANTED;
    }

    static void writeDocument(Context context, Uri uri, int flags, CancellationSignal signal, DocumentContent content)
        throws IOException {
        if (!writableDocument(context, uri, flags)) throw new IOException("Choose a writable document in Files.");
        ParcelFileDescriptor fd = context.getContentResolver().openFileDescriptor(uri, "wt", signal);
        if (fd == null)
            throw new IOException("No writable document was returned.");
        try (OutputStream out = new ParcelFileDescriptor.AutoCloseOutputStream(fd)) {
            content.write(out);
        }
    }
    private synchronized PlaylistExportFile lookup(PluginCall call) {
        return active != null && active.id.equals(call.getString("id")) ? active : null;
    }
    private synchronized void finish(PlaylistExportFile file) {
        if (file == null)
            return;
        file.discard();
        if (active == file)
            active = null;
    }
    @PluginMethod
    public synchronized void discard(PluginCall call) {
        PlaylistExportFile file = lookup(call);
        if (file != null) {
            if (writing != null)
                writing.cancel();
            finish(file);
        }
        call.resolve();
    }
    @Override
    protected synchronized void handleOnDestroy() {
        if (writing != null)
            writing.cancel();
        finish(active);
        io.shutdownNow();
    }
}
