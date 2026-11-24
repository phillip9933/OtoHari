package app.droppedneedle.mobile;

import android.media.AudioFormat;
import android.media.MediaDataSource;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.net.Uri;
import androidx.media3.common.MediaItem;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import okhttp3.OkHttpClient;
import okhttp3.Response;
import org.json.JSONObject;

/** Measure only the two edges. Retain the outgoing PCM so playback never opens an extra full track. */
@androidx.annotation.OptIn(markerClass = androidx.media3.common.util.UnstableApi.class)
final class SmartFadeAudio {
    interface Reader {
        Edge read(MediaItem item, boolean tail, TrackWaveform.Job job) throws IOException;
    }

    static JSONObject metadata(MediaItem item) {
        return item != null && item.localConfiguration != null && item.localConfiguration.tag instanceof JSONObject
                ? (JSONObject) item.localConfiguration.tag : null;
    }

    static long durationMs(MediaItem item) {
        JSONObject track = metadata(item);
        return track == null ? 0 : Math.round(track.optDouble("duration", 0) * 1000);
    }

    static Reader library(PlaybackService.Access owner, OkHttpClient http) {
        return (item, tail, job) -> {
            if (owner == null || item.localConfiguration == null) throw new IOException("No playback account.");
            Uri uri = item.localConfiguration.uri;
            long duration = durationMs(item);
            File file = owner.offline == null ? null : owner.offline.artworkSource(uri.toString());
            if (file != null) return local(file, duration, tail, job);
            if (!owner.allowsOnlineMedia()) throw new IOException("Track is unavailable offline.");
            return online(owner, uri, owner.profiles.track().forRequest(uri), duration, tail, http, job);
        };
    }

    static Edge online(PlaybackService.Access owner, Uri uri, Uri selected, long duration, boolean tail,
                       OkHttpClient http, TrackWaveform.Job job) throws IOException {
        if (ConversionSource.requested(selected) && duration > 0) {
            if (duration <= 0 || duration > TrackWaveform.MAX_DURATION_US / 1000) throw new IOException("Track exceeds fade analysis limits.");
            int window = window(duration);
            long start = tail ? duration - window : 0;
            Uri excerpt = start > 0 ? ConversionSource.streamAt(selected, start) : selected;
            try (Response response = TrackWaveform.open(job, owner, excerpt, http, null)) {
                if (response.isSuccessful() && response.body() != null && ConversionSource.converted(response.headers().toMultimap())) {
                    // Live conversions don't support byte seeks. Ask DN for its normal time seek and
                    // consume at most a few seconds at the user's selected network bitrate.
                    int kbps = 320;
                    try { kbps = Math.max(64, Math.min(320, Integer.parseInt(selected.getQueryParameter("max_bitrate")))); }
                    catch (NumberFormatException ignored) { }
                    int budget = (window + 2500) * kbps / 8 + 65536;
                    byte[] excerptBytes = new byte[budget];
                    int length = 0;
                    InputStream body = response.body().byteStream();
                    while (length < budget) {
                        job.check();
                        if (!owner.allowsOnlineMedia()) throw new IOException("Online media is unavailable.");
                        int count = body.read(excerptBytes, length, budget - length);
                        if (count < 0) break;
                        length += count;
                    }
                    return decode(new Bytes(excerptBytes, length), duration, tail, true, job);
                }
                // The server can pass a matching original through a requested conversion.
                if (response.code() == 409) selected = ConversionSource.original(uri);
                else if (!response.isSuccessful()) throw new IOException("Audio excerpt is unavailable.");
            }
        }
        try (Ranges ranges = new Ranges(owner, selected, http, job)) {
            return decode(ranges, duration, tail, false, job);
        }
    }

    static Edge local(File file, long duration, boolean tail, TrackWaveform.Job job) throws IOException {
        MediaExtractor source = new MediaExtractor();
        try {
            source.setDataSource(file.getAbsolutePath());
            return decode(source, duration, tail, false, job);
        } finally { source.release(); }
    }

    private static Edge decode(MediaDataSource data, long duration, boolean tail, boolean excerpt,
                               TrackWaveform.Job job) throws IOException {
        MediaExtractor source = new MediaExtractor();
        try {
            source.setDataSource(data);
            return decode(source, duration, tail, excerpt, job);
        } finally { source.release(); }
    }

    private static int window(long duration) {
        return (int) (Math.min(SmartFadePlan.MAX_MS, duration / 2) / SmartFadePlan.BIN_MS * SmartFadePlan.BIN_MS);
    }

    private static Edge decode(MediaExtractor source, long duration, boolean tail, boolean excerpt,
                               TrackWaveform.Job job) throws IOException {
        for (int track = 0; track < source.getTrackCount(); track++) {
            MediaFormat format = source.getTrackFormat(track);
            String mime = format.getString(MediaFormat.KEY_MIME);
            if (mime == null || !mime.startsWith("audio/")) continue;
            if (!excerpt && format.containsKey(MediaFormat.KEY_DURATION)) duration = format.getLong(MediaFormat.KEY_DURATION) / 1000;
            if (duration <= 0 || duration > TrackWaveform.MAX_DURATION_US / 1000) throw new IOException("Track exceeds fade analysis limits.");
            int window = window(duration);
            if (window < SmartFadePlan.BIN_MS) throw new IOException("Track is too short to measure.");
            long start = tail && !excerpt ? (duration - window) * 1000 : 0;
            source.selectTrack(track);
            if (start > 0) source.seekTo(start, MediaExtractor.SEEK_TO_PREVIOUS_SYNC);
            Edge edge = new Edge(duration, window, start, tail);
            TrackWaveform.readPcm(source, format, mime, start + window * 1000L, TrackWaveform.EDGE_PCM_BYTES, job, edge::sample);
            edge.finish();
            return edge;
        }
        throw new IOException("No audio track.");
    }

    static final class Edge {
        final long duration, startUs;
        final int windowMs;
        final float[] rms;
        final boolean tail;
        private final double[] energy;
        private final int[] counts;
        private int rate, channels, frames;
        byte[] wave;

        Edge(long duration, int window, long startUs, boolean tail) {
            this.duration = duration;
            this.startUs = startUs;
            windowMs = window;
            this.tail = tail;
            rms = new float[window / SmartFadePlan.BIN_MS];
            energy = new double[rms.length];
            counts = new int[rms.length];
        }

        private void format(int hz, int count) throws IOException {
            if (rate != 0) {
                if (rate != hz || channels != count) throw new IOException("Audio format changed.");
                return;
            }
            if (hz <= 0 || hz > 192000 || count < 1 || count > (tail ? 2 : 8)) throw new IOException("Unsupported audio layout.");
            rate = hz;
            channels = count;
            frames = (int) Math.round(windowMs * rate / 1000d);
            if (tail) {
                int length = frames * channels * 2;
                wave = new byte[44 + length];
                ByteBuffer header = ByteBuffer.wrap(wave).order(ByteOrder.LITTLE_ENDIAN);
                header.put("RIFF".getBytes(StandardCharsets.US_ASCII)).putInt(36 + length);
                header.put("WAVEfmt ".getBytes(StandardCharsets.US_ASCII)).putInt(16).putShort((short) 1);
                header.putShort((short) channels).putInt(rate).putInt(rate * channels * 2);
                header.putShort((short) (channels * 2)).putShort((short) 16);
                header.put("data".getBytes(StandardCharsets.US_ASCII)).putInt(length);
            }
        }

        private boolean sample(ByteBuffer data, MediaFormat decoded, long timeUs) throws IOException {
            format(decoded.getInteger(MediaFormat.KEY_SAMPLE_RATE), decoded.getInteger(MediaFormat.KEY_CHANNEL_COUNT));
            int encoding = decoded.containsKey(MediaFormat.KEY_PCM_ENCODING)
                    ? decoded.getInteger(MediaFormat.KEY_PCM_ENCODING) : AudioFormat.ENCODING_PCM_16BIT;
            int frameBytes = channels * TrackWaveform.sampleBytes(encoding);
            long first = Math.round((timeUs - startUs) * rate / 1000000d);
            int size = data.remaining() / frameBytes;
            if (first >= frames || first + size <= 0) return false;
            data.order(ByteOrder.LITTLE_ENDIAN);
            if (first < 0) data.position(data.position() + (int) -first * frameBytes);
            int end = (int) Math.min(frames, first + size);
            for (int frame = (int) Math.max(0, first); frame < end; frame++) {
                int fromBoundary = tail ? frames - 1 - frame : frame;
                int bin = (int) ((long) fromBoundary * rms.length / frames);
                for (int c = 0; c < channels; c++) {
                    float value = TrackWaveform.sampleValue(data, encoding);
                    if (!Float.isFinite(value)) throw new IOException("Invalid PCM sample.");
                    energy[bin] += (double) value * value;
                    counts[bin]++;
                    if (tail) {
                        int sample = Math.max(-32768, Math.min(32767, Math.round(value * 32768)));
                        int at = 44 + (frame * channels + c) * 2;
                        wave[at] = (byte) sample;
                        wave[at + 1] = (byte) (sample >> 8);
                    }
                }
            }
            return true;
        }

        private void finish() throws IOException {
            int expected = frames * channels / rms.length;
            for (int i = 0; i < rms.length; i++) {
                // Missing PCM (unsupported seek, truncated file) is never inferred to be silence.
                if (expected == 0 || counts[i] < expected * .9) throw new IOException("Audio edge is incomplete.");
                rms[i] = (float) Math.sqrt(energy[i] / counts[i]);
            }
        }
    }

    private static final class Bytes extends MediaDataSource {
        final byte[] bytes;
        final int length;
        Bytes(byte[] bytes, int length) { this.bytes = bytes; this.length = length; }
        @Override public long getSize() { return length; }
        @Override public int readAt(long position, byte[] dest, int off, int size) {
            if (size == 0) return 0;
            if (position < 0 || position >= length) return -1;
            int n = (int) Math.min(size, length - position);
            System.arraycopy(bytes, (int) position, dest, off, n);
            return n;
        }
        @Override public void close() {}
    }

    /** Android's extractor may seek to container metadata. Serve validated DN ranges within a per-edge budget. */
    private static final class Ranges extends MediaDataSource {
        private static final int BLOCK = 128 * 1024;
        private static final Pattern RANGE = Pattern.compile("bytes (\\d+)-(\\d+)/(\\d+)");
        private final PlaybackService.Access owner;
        private final Uri uri;
        private final OkHttpClient http;
        private final TrackWaveform.Job job;
        private byte[] bytes = new byte[0];
        private long offset, total = -1, used;
        Ranges(PlaybackService.Access owner, Uri uri, OkHttpClient http, TrackWaveform.Job job) {
            this.owner = owner; this.uri = uri; this.http = http; this.job = job;
        }
        private void fill(long position) throws IOException {
            job.check();
            if (!owner.allowsOnlineMedia() || used >= 12L * 1024 * 1024) throw new IOException("Range budget unavailable.");
            try (Response response = TrackWaveform.open(job, owner, uri, http, "bytes=" + position + "-" + (position + BLOCK - 1))) {
                Matcher range = RANGE.matcher(response.header("Content-Range", ""));
                if (response.code() != 206 || response.body() == null || !range.matches()) throw new IOException("Track cannot be ranged.");
                long start = Long.parseLong(range.group(1)), end = Long.parseLong(range.group(2)), length = Long.parseLong(range.group(3));
                if (start != position || end < start || end - start >= BLOCK || end >= length || total > 0 && total != length)
                    throw new IOException("Invalid audio range.");
                bytes = response.body().source().readByteArray(end - start + 1);
                offset = start;
                total = length;
                used += bytes.length;
            }
        }
        @Override public synchronized long getSize() throws IOException {
            if (total < 0) fill(0);
            return total;
        }
        @Override public synchronized int readAt(long position, byte[] dest, int off, int size) throws IOException {
            if (size == 0) return 0;
            if (position < 0 || position >= getSize()) return -1;
            if (position < offset || position >= offset + bytes.length) fill(position);
            int n = Math.min(size, bytes.length - (int) (position - offset));
            System.arraycopy(bytes, (int) (position - offset), dest, off, n);
            return n;
        }
        @Override public void close() { bytes = new byte[0]; }
    }
    private SmartFadeAudio() {}
}
