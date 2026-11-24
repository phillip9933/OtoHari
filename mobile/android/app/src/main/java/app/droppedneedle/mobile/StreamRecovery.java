package app.droppedneedle.mobile;

import androidx.annotation.Nullable;
import androidx.media3.common.PlaybackException;
import androidx.media3.datasource.HttpDataSource;
import java.net.NoRouteToHostException;
import java.util.Objects;
import javax.net.ssl.SSLException;

/** Retry an interrupted listen on its replacement route, retaining Media3's queue and media time. */
@androidx.annotation.OptIn(markerClass = androidx.media3.common.util.UnstableApi.class)
final class StreamRecovery {
    static final long WAIT_MS = 120_000;
    private Object network, occurrence;
    private StreamProfiles.Path path;
    private long route, attemptedRoute, lastAttemptPosition, failedSince = -1;
    private int attempts;

    void network(@Nullable Object active, StreamProfiles.Path transport) {
        if (!Objects.equals(active, network) || transport != path) {
            network = active;
            path = transport;
            route++;
        }
    }

    void follow(@Nullable Object item) {
        if (item == occurrence) return;
        occurrence = item;
        attemptedRoute = route;
        attempts = 0;
        failedSince = -1;
    }

    void ready() { failedSince = -1; }

    boolean retry(long position, long now) {
        if (occurrence == null) return false;
        if (failedSince < 0) failedSince = now;
        if (network == null || route == attemptedRoute || now - failedSince >= WAIT_MS) return false;
        if (position - lastAttemptPosition >= 5_000) attempts = 0;
        if (attempts >= 2) return false;
        attemptedRoute = route;
        lastAttemptPosition = position;
        attempts++;
        return true;
    }

    static boolean transportError(@Nullable PlaybackException failure) {
        return failure != null && transportError(failure.errorCode, failure.getCause());
    }

    static boolean transportError(int code, @Nullable Throwable cause) {
        boolean network = code == PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED
                || code == PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT;
        if (!network && code != PlaybackException.ERROR_CODE_IO_UNSPECIFIED) return false;
        for (; cause != null; cause = cause.getCause()) {
            if (cause instanceof SSLException || cause instanceof HttpDataSource.InvalidResponseCodeException) return false;
            if (cause instanceof NoRouteToHostException) network = true;
        }
        return network;
    }
}
