package app.droppedneedle.mobile;

import android.net.Uri;
import com.getcapacitor.JSObject;
import androidx.annotation.Nullable;
import androidx.media3.common.C;
import androidx.media3.common.DataReader;
import androidx.media3.common.MediaItem;
import androidx.media3.datasource.DataSource;
import androidx.media3.exoplayer.drm.DrmSessionManagerProvider;
import androidx.media3.exoplayer.source.BundledExtractorsAdapter;
import androidx.media3.exoplayer.source.MediaSource;
import androidx.media3.exoplayer.source.ProgressiveMediaExtractor;
import androidx.media3.exoplayer.source.ProgressiveMediaSource;
import androidx.media3.exoplayer.upstream.LoadErrorHandlingPolicy;
import androidx.media3.extractor.DefaultExtractorsFactory;
import androidx.media3.extractor.Extractor;
import androidx.media3.extractor.ExtractorOutput;
import androidx.media3.extractor.ForwardingExtractorOutput;
import androidx.media3.extractor.ForwardingTrackOutput;
import androidx.media3.extractor.PositionHolder;
import androidx.media3.extractor.SeekMap;
import androidx.media3.extractor.SeekPoint;
import androidx.media3.extractor.TrackOutput;
import java.io.File;
import java.io.IOException;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.WeakHashMap;
import org.json.JSONObject;

/** DN live conversions restart at a time. Direct responses and offline files use Media3's normal byte seeking. */
@androidx.annotation.OptIn(markerClass = androidx.media3.common.util.UnstableApi.class)
final class ConversionSource implements MediaSource.Factory {
    interface Streams {
        DataSource create(Timeline timeline);
    }
    private final Streams streams;
    private final Map<Object, Timeline> timelines = new WeakHashMap<>();
    private DrmSessionManagerProvider drm;
    private LoadErrorHandlingPolicy policy;

    ConversionSource(Streams streams) {
        this.streams = streams;
    }
    @Nullable
    synchronized JSObject delivery(Object occurrence) {
        Timeline timeline = timelines.get(occurrence);
        return timeline == null ? null : timeline.delivery;
    }

    synchronized boolean hasCompleteFile(Object occurrence) {
        Timeline timeline = timelines.get(occurrence);
        File file = timeline == null ? null : timeline.opened.file;
        return file != null && file.isFile();
    }

    // A late completion on an older DataSource cannot mark a newly opened rendition as complete.
    static final class OpenedAudio {
        @Nullable volatile File file;
        OpenedAudio(@Nullable File file) { this.file = file; }
    }

    @Override
    public MediaSource createMediaSource(MediaItem item) {
        Object tag = item.localConfiguration.tag;
        double seconds = tag instanceof JSONObject ? ((JSONObject) tag).optDouble("duration", 0) : 0;
        Timeline timeline = new Timeline(seconds > 0 ? Math.round(seconds * 1_000_000) : C.TIME_UNSET);
        if (tag != null) synchronized (this) { timelines.put(tag, timeline); }
        ProgressiveMediaSource.Factory factory = new ProgressiveMediaSource.Factory(
                () -> streams.create(timeline), playerId -> new Reader(timeline));
        if (drm != null)
            factory.setDrmSessionManagerProvider(drm);
        if (policy != null)
            factory.setLoadErrorHandlingPolicy(policy);
        return factory.createMediaSource(item);
    }
    @Override
    public int[] getSupportedTypes() {
        return new int[] {C.CONTENT_TYPE_OTHER};
    }
    @Override
    public MediaSource.Factory setDrmSessionManagerProvider(DrmSessionManagerProvider drm) {
        this.drm = drm;
        return this;
    }
    @Override
    public MediaSource.Factory setLoadErrorHandlingPolicy(LoadErrorHandlingPolicy policy) {
        this.policy = policy;
        return this;
    }

    /** A byte address identifies both a new conversion and the bytes consumed on a subsequent read retry. */
    static final class Timeline implements SeekMap {
        volatile JSObject delivery;
        volatile OpenedAudio opened = new OpenedAudio(null);
        // The gateway can never serve a local audio file at this offset (one exbibyte).
        private static final long FIRST_SEGMENT = 1L << 60;
        private static final long BLOCK = 1L << 40;
        private final long durationUs;
        private final Map<Long, Long> starts = new HashMap<>();
        private final Map<Long, Long> addresses = new HashMap<>();

        Timeline(long durationUs) {
            this.durationUs = durationUs;
        }
        @Override
        public boolean isSeekable() {
            return true;
        }
        @Override
        public long getDurationUs() {
            return durationUs;
        }
        @Override
        public synchronized SeekPoints getSeekPoints(long timeUs) {
            long ms = Math.max(0, timeUs) / 1000;
            if (ms == 0)
                return new SeekPoints(SeekPoint.START);
            Long base = addresses.get(ms);
            if (base == null) {
                base = FIRST_SEGMENT + BLOCK * addresses.size();
                addresses.put(ms, base);
                starts.put(base, ms);
            }
            return new SeekPoints(new SeekPoint(ms * 1000, base));
        }
        long base(long position) {
            return position < FIRST_SEGMENT ? 0 : position - (position % BLOCK);
        }
        synchronized long startMs(long position) throws IOException {
            long base = base(position);
            if (base == 0)
                return 0;
            Long ms = starts.get(base);
            if (ms == null)
                throw new IOException("This seek no longer belongs to the current song.");
            return ms;
        }
    }

    static boolean requested(Uri uri) {
        if (!uri.isHierarchical())
            return false;
        String format = uri.getQueryParameter("format");
        return "mp3".equals(format) || "opus".equals(format);
    }
    static boolean converted(Map<String, List<String>> headers) {
        for (Map.Entry<String, List<String>> h : headers.entrySet()) {
            if ("Accept-Ranges".equalsIgnoreCase(h.getKey())) {
                for (String value : h.getValue())
                    if ("none".equalsIgnoreCase(value.trim()))
                        return true;
            }
        }
        return false;
    }
    static Uri streamAt(Uri uri, long ms) {
        return uri.buildUpon()
                .appendQueryParameter("start_seconds", String.format(Locale.ROOT, "%.3f", ms / 1000.0))
                .build();
    }
    static Uri original(Uri uri) {
        // The native queue only accepts authenticated local DN audio paths.
        return uri.buildUpon().clearQuery().appendQueryParameter("format", "raw").build();
    }

    private static final class Reader implements ProgressiveMediaExtractor {
        private final DefaultExtractorsFactory extractors = new DefaultExtractorsFactory();
        private final Timeline timeline;
        private BundledExtractorsAdapter delegate = new BundledExtractorsAdapter(extractors);
        private long activeBase = -1;
        private boolean live;

        Reader(Timeline timeline) {
            this.timeline = timeline;
        }
        @Override
        public void init(DataReader input, Uri uri, Map<String, List<String>> headers, long position, long end,
                ExtractorOutput output) throws IOException {
            long base = timeline.base(position);
            // DN writes CBR MP3 conversions to a pipe without a Xing seek table. Once saved locally,
            // the entire file length is known and Media3 can calculate ordinary byte seeks.
            extractors.setConstantBitrateSeekingEnabled("file".equals(uri.getScheme()));
            boolean converted = requested(uri) && converted(headers);
            if (activeBase != -1 && (activeBase != base || live != converted || (live && position == base))) {
                // Each ffmpeg invocation starts a fresh container, including the codec headers.
                delegate.release();
                delegate = new BundledExtractorsAdapter(extractors);
            }
            activeBase = base;
            live = converted;
            long offsetUs = live ? timeline.startMs(position) * 1000 : 0;
            ExtractorOutput destination = live ? new ForwardingExtractorOutput(output) {
                @Override
                public void seekMap(SeekMap original) {
                    super.seekMap(timeline);
                }
                @Override
                public TrackOutput track(int id, int type) {
                    return new ForwardingTrackOutput(super.track(id, type)) {
                        @Override
                        public void sampleMetadata(
                                long timeUs, int flags, int size, int at, @Nullable CryptoData crypto) {
                            super.sampleMetadata(timeUs + offsetUs, flags, size, at, crypto);
                        }
                    };
                }
            } : output;
            // Ogg in particular would seek to the segment's tail to discover a misleading partial duration.
            delegate.init(input, uri, headers, position - base,
                    live || end == C.LENGTH_UNSET ? C.LENGTH_UNSET : end - base, destination);
        }
        @Override
        public void seek(long position, long timeUs) {
            if (live) {
                // init() has just installed a fresh reader at the start of the requested segment.
                return;
            }
            if (activeBase > 0) {
                // A saved file or direct fallback appeared during a seek. Decode from its true origin;
                // Media3's SampleQueue already skips samples before the requested absolute time.
                return;
            }
            delegate.seek(position, timeUs);
        }
        @Override
        public int read(PositionHolder next) throws IOException {
            int result = delegate.read(next);
            if (result == Extractor.RESULT_SEEK && activeBase > 0)
                next.position += activeBase;
            return result;
        }
        @Override
        public long getCurrentInputPosition() {
            long physical = delegate.getCurrentInputPosition();
            return physical < 0 || activeBase <= 0 ? physical : activeBase + physical;
        }
        @Override
        public void release() {
            delegate.release();
        }
        @Override
        public void disableSeekingOnMp3Streams() {
            delegate.disableSeekingOnMp3Streams();
        }
    }
}
