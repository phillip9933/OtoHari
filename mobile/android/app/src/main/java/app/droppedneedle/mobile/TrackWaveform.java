package app.droppedneedle.mobile;

import android.media.AudioFormat;
import android.media.MediaCodec;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.net.Uri;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Consumer;
import okhttp3.Call;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;

/** Decode the selected song away from the playback thread. The result contains only amplitude peaks. */
final class TrackWaveform {
    static final int BINS = 112;
    private static final long MAX_DOWNLOAD = 128L * 1024 * 1024;
    static final long MAX_DURATION_US = 3600_000_000L;
    private static final long WAVE_PCM_BYTES = 256L * 1024 * 1024;
    static final long EDGE_PCM_BYTES = 48L * 1024 * 1024;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private Job active;

    static final class Job {
        final String request;
        final long deadline;
        volatile boolean cancelled;
        volatile Call network;
        Job(String request) { this(request, 30_000); }
        Job(String request, long timeoutMs) {
            this.request = request;
            deadline = timeoutMs == 0 ? 0 : System.nanoTime() + timeoutMs * 1_000_000;
        }
        void check() throws IOException {
            if (cancelled || Thread.currentThread().isInterrupted() || deadline != 0 && System.nanoTime() >= deadline)
                throw new IOException("Waveform canceled.");
        }
        void cancel() {
            cancelled = true;
            Call call = network;
            if (call != null) call.cancel();
        }
    }

    void cancel(String request) {
        if (active != null && active.request.equals(request)) active.cancel();
    }

    void close() {
        if (active != null) active.cancel();
        worker.shutdown();
    }

    void read(String request, File directory, PlaybackService.Access owner, Uri stream, double seconds,
              OkHttpClient http, Consumer<JSObject> complete) {
        if (active != null) active.cancel();
        Job job = new Job(request);
        active = job;
        worker.execute(() -> {
            File temporary = null;
            JSArray values = new JSArray();
            try {
                job.check();
                File file = owner.offline == null ? null : owner.offline.artworkSource(stream.toString());
                String id = file == null ? null : owner.offline.trackId(stream.toString());
                long revision = id == null ? 0 : owner.offline.itemRevision(id);
                if (id != null) {
                    String ready = owner.offline.companions().field(OfflineStore.digest(id), "peaks");
                    if (ready != null) { values = new JSArray(ready); return; }
                }
                if (file == null) {
                    if (!owner.allowsOnlineMedia()) throw new IOException("Not available offline.");
                    temporary = File.createTempFile("dn-wave-", ".audio", directory);
                    Uri uri = owner.profiles.track().forRequest(stream);
                    try (Response initial = open(job, owner, uri, http)) {
                        if (initial.code() == 409 && ConversionSource.requested(uri)) {
                            try (Response raw = open(job, owner, ConversionSource.original(stream), http)) {
                                copy(raw, temporary, job, owner);
                            }
                        } else copy(initial, temporary, job, owner);
                    }
                    file = temporary;
                }
                for (float peak : decode(file, seconds, job)) values.put((double) peak);
                if (id != null && owner.offline.downloadWaveforms() && values.length() == BINS)
                    owner.offline.putCompanions(id, revision, null, null, null, values.toString());
            } catch (IOException | org.json.JSONException | RuntimeException ignored) {
                // An unavailable waveform leaves the normal seek control and playback operational.
            } finally {
                if (temporary != null) temporary.delete();
                JSObject out = new JSObject();
                out.put("peaks", values);
                complete.accept(out);
            }
        });
    }

    static Response open(Job job, PlaybackService.Access owner, Uri uri, OkHttpClient http, String range) throws IOException {
        if (!owner.allowsOnlineMedia()) throw new IOException("Online media is unavailable.");
        Request.Builder builder = new Request.Builder().url(uri.toString())
                .tag(PlaybackService.Access.class, owner).header("Authorization", "Bearer " + owner.token);
        if (range != null) builder.header("Range", range);
        Request request = builder.build();
        if (!owner.permits(request.url(), "stream/local/")) throw new IOException("Invalid track address.");
        job.network = http.newCall(request);
        if (job.deadline != 0) job.network.timeout().deadlineNanoTime(job.deadline);
        job.check();
        return job.network.execute();
    }

    private static Response open(Job job, PlaybackService.Access owner, Uri uri, OkHttpClient http) throws IOException {
        return open(job, owner, uri, http, null);
    }

    private static void copy(Response response, File file, Job job, PlaybackService.Access owner) throws IOException {
        if (!response.isSuccessful() || response.body() == null || response.body().contentLength() > MAX_DOWNLOAD)
            throw new IOException("Waveform audio unavailable.");
        try (InputStream in = response.body().byteStream(); FileOutputStream out = new FileOutputStream(file)) {
            byte[] chunk = new byte[65536];
            long size = 0;
            for (int n; (n = in.read(chunk)) != -1;) {
                job.check();
                if (!owner.allowsOnlineMedia()) throw new IOException("Not available offline.");
                size += n;
                if (size > MAX_DOWNLOAD) throw new IOException("File too large for waveform analysis.");
                out.write(chunk, 0, n);
            }
        }
    }

    static float[] decode(File file, double seconds) throws IOException { return decode(file, seconds, new Job("local")); }

    static float[] decode(File file, double seconds, Job job) throws IOException {
        if (file.length() <= 0 || file.length() > MAX_DOWNLOAD) return new float[0];
        MediaExtractor source = new MediaExtractor();
        try {
            source.setDataSource(file.getAbsolutePath());
            for (int i = 0; i < source.getTrackCount(); i++) {
                MediaFormat format = source.getTrackFormat(i);
                String mime = format.getString(MediaFormat.KEY_MIME);
                if (mime == null || !mime.startsWith("audio/")) continue;
                long duration = format.containsKey(MediaFormat.KEY_DURATION)
                        ? format.getLong(MediaFormat.KEY_DURATION) : (long) (seconds * 1_000_000);
                if (duration <= 0 || duration > MAX_DURATION_US) return new float[0];
                source.selectTrack(i);
                float[] peaks = new float[BINS];
                boolean sampled = readPcm(source, format, mime, duration, WAVE_PCM_BYTES, job,
                        (data, decoded, timeUs) -> sample(data, decoded, timeUs, duration, peaks));
                return sampled ? peaks : new float[0];
            }
            return new float[0];
        } finally { source.release(); }
    }

    interface PcmSink {
        boolean accept(ByteBuffer data, MediaFormat decoded, long timeUs) throws IOException;
    }

    private static long framesIn(int size, MediaFormat format) throws IOException {
        int channels = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT);
        int rate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE);
        if (rate < 1 || rate > 192000 || channels < 1 || channels > 8)
            throw new IOException("Unsupported decoded audio layout.");
        int encoding = format.containsKey(MediaFormat.KEY_PCM_ENCODING) ? format.getInteger(MediaFormat.KEY_PCM_ENCODING) : AudioFormat.ENCODING_PCM_16BIT;
        return size / (channels * sampleBytes(encoding));
    }

    static boolean readPcm(MediaExtractor source, MediaFormat format, String mime, long endUs, long budget, Job job,
                           PcmSink sink) throws IOException {
        int rate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE), channels = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT);
        if (rate <= 0 || rate > 192000 || channels < 1 || channels > 8)
            throw new IOException("Audio layout exceeds analysis limits.");
        if (format.containsKey(MediaFormat.KEY_MAX_INPUT_SIZE) && format.getInteger(MediaFormat.KEY_MAX_INPUT_SIZE) > 4 * 1024 * 1024)
            throw new IOException("Audio packets exceed analysis limits.");
        long framesLeft = budget == WAVE_PCM_BYTES ? 64_000_000L : 4_000_000L;
        if ("audio/raw".equals(mime)) {
            int max = format.containsKey(MediaFormat.KEY_MAX_INPUT_SIZE) ? format.getInteger(MediaFormat.KEY_MAX_INPUT_SIZE) : 0;
            ByteBuffer buffer = ByteBuffer.allocateDirect(Math.max(65536, Math.min(4 * 1024 * 1024, max)));
            boolean sampled = false;
            while (source.getSampleTime() >= 0 && source.getSampleTime() < endUs) {
                job.check();
                buffer.clear();
                int size = source.readSampleData(buffer, 0);
                if (size < 0) break;
                framesLeft -= framesIn(size, format);
                if (framesLeft < 0 || size > budget) throw new IOException("Audio exceeds analysis limits.");
                budget -= size;
                buffer.position(0).limit(size);
                sampled |= sink.accept(buffer, format, source.getSampleTime());
                source.advance();
            }
            return sampled;
        }
        MediaCodec codec = MediaCodec.createDecoderByType(mime);
        try {
            codec.configure(format, null, null, 0);
            codec.start();
            MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
            boolean inputDone = false;
            boolean sampled = false;
            while (true) {
                job.check();
                if (!inputDone) {
                    int index = codec.dequeueInputBuffer(5000);
                    if (index >= 0) {
                        ByteBuffer in = codec.getInputBuffer(index);
                        if (in == null) throw new IOException("Decoder input unavailable.");
                        int size = source.getSampleTime() >= endUs ? -1 : source.readSampleData(in, 0);
                        inputDone = size < 0;
                        codec.queueInputBuffer(index, 0, Math.max(size, 0), inputDone ? 0 : source.getSampleTime(),
                                inputDone ? MediaCodec.BUFFER_FLAG_END_OF_STREAM : 0);
                        if (!inputDone) source.advance();
                    }
                }
                int out = codec.dequeueOutputBuffer(info, 5000);
                if (out >= 0) {
                    ByteBuffer pcm = codec.getOutputBuffer(out);
                    if (pcm != null && info.size > 0) {
                        MediaFormat decoded = codec.getOutputFormat(out);
                        framesLeft -= framesIn(info.size, decoded);
                        if (framesLeft < 0 || info.size > budget || info.size > 4 * 1024 * 1024)
                            throw new IOException("Audio exceeds analysis limits.");
                        budget -= info.size;
                        pcm.position(info.offset).limit(info.offset + info.size);
                        sampled |= sink.accept(pcm, decoded, info.presentationTimeUs);
                    }
                    codec.releaseOutputBuffer(out, false);
                    if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) return sampled;
                }
            }
        } finally { codec.release(); }
    }

    private static boolean sample(ByteBuffer data, MediaFormat format, long startUs, long duration,
                                  float[] peaks) throws IOException {
        if (startUs < 0 || startUs > duration) return false;
        int encoding = format.containsKey(MediaFormat.KEY_PCM_ENCODING) ? format.getInteger(MediaFormat.KEY_PCM_ENCODING) : AudioFormat.ENCODING_PCM_16BIT;
        int channels = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT), rate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE);
        int bytes = sampleBytes(encoding);
        if (rate <= 0 || channels <= 0 || channels > 64) throw new IOException("Invalid PCM format.");
        data.order(ByteOrder.LITTLE_ENDIAN);
        int frames = data.remaining() / (bytes * channels);
        for (int f = 0; f < frames; f++) {
            long timestamp = startUs + f * 1_000_000L / rate;
            int bin = (int) Math.max(0, Math.min(peaks.length - 1, timestamp * peaks.length / duration));
            for (int c = 0; c < channels; c++) {
                float value = sampleValue(data, encoding);
                if (Float.isFinite(value)) peaks[bin] = Math.max(peaks[bin], Math.abs(value));
            }
        }
        return frames > 0;
    }

    static int sampleBytes(int encoding) {
        return encoding == AudioFormat.ENCODING_PCM_8BIT ? 1 : encoding == AudioFormat.ENCODING_PCM_16BIT ? 2
                : encoding == AudioFormat.ENCODING_PCM_24BIT_PACKED ? 3 : 4;
    }

    static float sampleValue(ByteBuffer data, int encoding) throws IOException {
        switch (encoding) {
            case AudioFormat.ENCODING_PCM_8BIT: return ((data.get() & 255) - 128) / 128f;
            case AudioFormat.ENCODING_PCM_16BIT: return data.getShort() / 32768f;
            case AudioFormat.ENCODING_PCM_24BIT_PACKED:
                return ((data.get() & 255) | ((data.get() & 255) << 8) | (data.get() << 16)) / 8388608f;
            case AudioFormat.ENCODING_PCM_32BIT: return data.getInt() / 2147483648f;
            case AudioFormat.ENCODING_PCM_FLOAT: return data.getFloat();
            default: throw new IOException("Unsupported PCM format.");
        }
    }
}
