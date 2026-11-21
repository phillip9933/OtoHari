package app.droppedneedle.mobile;

import static org.junit.Assert.*;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.concurrent.atomic.AtomicInteger;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Protocol;
import okhttp3.Response;
import okhttp3.ResponseBody;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class PlaylistExportFileTest {
    @Rule public TemporaryFolder files = new TemporaryFolder();
    private static final String SERVER = "https://export.example/music", ID = "00000000-0000-4000-8000-000000000000";
    private static final String URL = SERVER + "/api/v3/playlists/test/export?format=csv&prefix=Music%2F%E9%9B%A8";
    private PlaylistExportFile file() {
        return new PlaylistExportFile(files.getRoot(), ID, "csv");
    }
    private static OkHttpClient fixture(int status, String type, byte[] bytes) {
        return PlaylistExportFile.network()
            .addInterceptor(chain -> {
                assertEquals(URL, chain.request().url().toString());
                assertEquals("Bearer fixture", chain.request().header("Authorization"));
                assertEquals("GET", chain.request().method());
                return new Response.Builder()
                    .request(chain.request())
                    .protocol(Protocol.HTTP_1_1)
                    .code(status)
                    .message("fixture")
                    .header("Content-Type", type)
                    .header("X-DroppedNeedle-Skipped-Tracks", "3")
                    .header("Content-Disposition", "attachment; filename=List.csv; filename*=UTF-8''%E9%9B%A8.csv")
                    .body(ResponseBody.create(MediaType.get(type), bytes))
                    .build();
            })
            .build();
    }
    @Test
    public void stagesAndWritesLargeExportsExactlyAndCleansUp() throws Exception {
        byte[] data = new byte[4 * 1024 * 1024 + 7];
        Arrays.fill(data, (byte) 'x');
        byte[] first = "title,artist\r\n雨,演奏家\r\n".getBytes(StandardCharsets.UTF_8);
        System.arraycopy(first, 0, data, 0, first.length);
        PlaylistExportFile file = file();
        OkHttpClient client = fixture(200, "text/csv; charset=UTF-8", data);
        assertFalse(client.followRedirects());
        assertFalse(client.followSslRedirects());
        file.prepare(client, SERVER, URL, "fixture");
        assertEquals("3", file.skipped);
        assertTrue(file.disposition.contains("%E9%9B%A8"));
        assertEquals("雨.csv", file.filename("雨.csv"));
        assertThrows(IOException.class, () -> file.filename("../outside.csv"));
        AtomicInteger largest = new AtomicInteger();
        ByteArrayOutputStream out = new ByteArrayOutputStream() {
            @Override
            public void write(byte[] bytes, int off, int len) {
                largest.accumulateAndGet(len, Math::max);
                super.write(bytes, off, len);
            }
        };
        file.copyTo(out);
        assertArrayEquals(data, out.toByteArray());
        assertTrue(largest.get() <= 64 * 1024);
        file.discard();
        file.discard();
        assertFalse(file.isReady());
        assertEquals(0, files.getRoot().list().length);
        assertThrows(IOException.class, () -> file.copyTo(out));
    }
    @Test
    public void distinguishesDnSignInFromProxyAndRefusesNonFiles() throws Exception {
        for (String[] c :
            new String[][] {{"401", "application/json", "{\"error\":{\"code\":\"UNAUTHORIZED\"}}", "DN_UNAUTHORIZED"},
                {"401", "text/html", "<html>Sign in</html>", "HTTP_401"}, {"404", "application/json", "{}", "HTTP_404"},
                {"302", "text/html", "<html>Sign in</html>", "HTTP_302"},
                {"200", "text/html", "<html>Sign in</html>", "EXPORT_TYPE"},
                {"200", "text/csv", "<html>Sign in</html>", "EXPORT_TYPE"}, {"200", "text/csv", "", "EXPORT_TYPE"}}) {
            PlaylistExportFile file = file();
            PlaylistExportFile.Failure e = assertThrows(PlaylistExportFile.Failure.class,
                ()
                    -> file.prepare(fixture(Integer.parseInt(c[0]), c[1], c[2].getBytes(StandardCharsets.UTF_8)),
                        SERVER, URL, "fixture"));
            assertEquals(c[3], e.code);
            assertFalse(file.isReady());
            assertEquals(0, files.getRoot().list().length);
        }
    }
    @Test
    public void budgetsBothDeclaredAndStreamedBytesAndCleansIncompleteExports() {
        final long reserve = 32L * 1024 * 1024;
        for (long length : new long[] {64L * 1024 * 1024 + 1, -1}) {
            File dir = new File(files.getRoot().toString()) {
                @Override public long getUsableSpace() { return length < 0 ? reserve + 64 : Long.MAX_VALUE; }
            };
            PlaylistExportFile export = new PlaylistExportFile(dir, ID, "csv");
            OkHttpClient client = PlaylistExportFile.network().addInterceptor(chain -> {
                byte[] body = new byte[128];
                Arrays.fill(body, (byte)'x');
                return new Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1)
                    .code(200).message("fixture").header("Content-Type", "text/csv")
                    .body(ResponseBody.create(MediaType.get("text/csv"), length, new okio.Buffer().write(body))).build();
            }).build();
            assertThrows(PlaylistExportFile.Failure.class, () -> export.prepare(client, SERVER, URL, "fixture"));
            assertFalse(export.isReady());
            assertEquals(0, files.getRoot().list().length);
        }
    }

    @Test
    public void rejectsWrongDestinationAndRouteBeforeSendingCredentials() {
        for (String target : new String[] {"https://elsewhere.example/music/api/v3/playlists/test/export?format=csv",
                 SERVER + "/api/v3/playlists/test/other?format=csv",
                 SERVER + "/api/v3/playlists/test%2Fother/export?format=csv", URL + "&format=m3u8", URL + "#part",
                 URL + "&token=value", "https://export.example:444/music/api/v3/playlists/test/export?format=csv",
                 "https://export.example/api/v3/playlists/test/export?format=csv"})
            assertThrows(IllegalArgumentException.class, () -> PlaylistExportFile.target(SERVER, target, "csv"));
    }
    @Test
    public void cancellationAndDestinationFailureLeaveNoPrivateFile() throws Exception {
        byte[] data = new byte[300000];
        Arrays.fill(data, (byte) 't');
        PlaylistExportFile file = file();
        file.prepare(fixture(200, "text/csv", data), SERVER, URL, "fixture");
        assertThrows(IOException.class, () -> file.copyTo(new OutputStream() {
            public void write(int i) throws IOException {
                throw new IOException("disk full");
            }
        }));
        assertThrows(IOException.class, () -> file.copyTo(new OutputStream() {
            public void write(int b) {}
            public void write(byte[] b, int o, int n) {
                file.discard();
            }
        }));
        assertFalse(file.isReady());
        assertEquals(0, files.getRoot().list().length);
        PlaylistExportFile aborted = file();
        aborted.discard();
        assertThrows(IOException.class, () -> aborted.prepare(fixture(200, "text/csv", data), SERVER, URL, "fixture"));
        assertEquals(0, files.getRoot().list().length);
    }
}
