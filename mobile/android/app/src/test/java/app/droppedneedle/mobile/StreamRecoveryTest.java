package app.droppedneedle.mobile;

import static org.junit.Assert.*;
import androidx.media3.common.PlaybackException;
import java.io.IOException;
import java.net.NoRouteToHostException;
import javax.net.ssl.SSLHandshakeException;
import org.junit.Test;

public final class StreamRecoveryTest {
    private final StreamRecovery recovery = new StreamRecovery();
    private final Object track = new Object();
    private void wifi() { recovery.network("wifi", StreamProfiles.Path.WIFI); }
    private void cell() { recovery.network("cell", StreamProfiles.Path.CELLULAR); }
    private void offline() { recovery.network(null, StreamProfiles.Path.OFFLINE); }

    @Test public void failureBeforeReplacementWaitsAndRepeatedNetworkNotificationsDoNotRetry() {
        wifi(); recovery.follow(track);
        assertFalse(recovery.retry(85_000, 1000));
        offline();
        assertFalse(recovery.retry(85_000, 2000));
        cell();
        assertTrue(recovery.retry(85_000, 3000));
        cell();
        assertFalse(recovery.retry(85_000, 4000));
    }

    @Test public void replacementBeforeFailureRetriesEvenIfOldSocketWasStillPlaying() {
        wifi(); recovery.follow(track); cell(); recovery.ready();
        assertTrue(recovery.retry(85_000, 5000));
        // Replacing the queued occurrence (including a duplicate of the track) discards its eligibility.
        recovery.follow(new Object());
        assertFalse(recovery.retry(0, 6000));
    }

    @Test public void repeatedHandoffsRequireProgressAndLongDisconnectedWaitsExpire() {
        wifi(); recovery.follow(track); cell(); assertTrue(recovery.retry(5000, 1000));
        wifi(); assertTrue(recovery.retry(5000, 2000));
        cell(); assertFalse(recovery.retry(5000, 3000));
        recovery.ready();
        assertTrue(recovery.retry(20_000, 4000));
        offline(); recovery.ready(); assertFalse(recovery.retry(21_000, 5000));
        wifi(); assertFalse(recovery.retry(21_000, 5000 + StreamRecovery.WAIT_MS));
    }

    @Test public void refusesToReopenSecurityFileAndDecodeFailures() {
        assertTrue(StreamRecovery.transportError(PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT, null));
        assertTrue(StreamRecovery.transportError(PlaybackException.ERROR_CODE_IO_UNSPECIFIED, new NoRouteToHostException()));
        assertFalse(StreamRecovery.transportError(PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED,
                new IOException(new SSLHandshakeException("certificate rejected"))));
        assertFalse(StreamRecovery.transportError(PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS, null));
        assertFalse(StreamRecovery.transportError(PlaybackException.ERROR_CODE_IO_UNSPECIFIED, new IOException()));
        assertFalse(StreamRecovery.transportError(PlaybackException.ERROR_CODE_DECODING_FAILED, null));
    }
}
