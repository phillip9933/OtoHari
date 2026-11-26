package app.droppedneedle.mobile

import io.github.phillip9933.appupdater.AndroidUpdateChannel
import io.github.phillip9933.appupdater.AndroidUpdateRelease
import io.github.phillip9933.appupdater.UpdateError
import io.github.phillip9933.appupdater.UpdateState
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class DNUpdatesTest {
    @Test fun resumingAfterPermissionSettingsCannotFinishAnEarlierInstallTap() = runBlocking {
        val window = ForegroundUpdateInstall()
        assertFalse(window.resumed)
        window.resume()
        val verifying = CompletableDeferred<Unit>()
        val first = async(start = CoroutineStart.UNDISPATCHED) {
            runCatching { window.prepare { verifying.await() } }
        }
        val duplicate = runCatching { window.prepare { error("Unexpected second verification") } }
        assertTrue(duplicate.exceptionOrNull()?.message.orEmpty().contains("already preparing"))
        window.pause()
        window.resume()
        val verifyingAgain = CompletableDeferred<Unit>()
        val second = async(start = CoroutineStart.UNDISPATCHED) {
            window.prepare {
                verifyingAgain.await()
                "current tap"
            }
        }
        verifying.complete(Unit)
        assertTrue(first.await().isFailure)
        verifyingAgain.complete(Unit)
        assertEquals("current tap", second.await())
    }

    @Test fun webStateKeepsReleaseOwnershipProgressAndPermissionSeparate() {
        val tag = "android-v2.0.0-beta.1"
        assertEquals("phillip9933", dnUpdateConfig.owner)
        assertEquals("OtoHari", dnUpdateConfig.repository)
        assertNull(dnUpdateConfig.versionFromTag("v2.0.0"))
        assertEquals("droppedneedle-android-2.0.0-beta.1.apk", dnUpdateConfig.assetName(tag))
        val state = UpdateState(
            installedVersion = "1.2.3",
            channel = AndroidUpdateChannel.BETA,
            available = AndroidUpdateRelease(tag, "<a>notes</a>", dnUpdateConfig.assetName(tag)!!,
                "https://example.invalid/release.apk", 8192, null, null),
            bytesDownloaded = 8192,
            ready = true,
            offer = false,
        )
        val snapshot = state.toBridgeState(false)
        assertTrue(snapshot.getBoolean("ready"))
        assertFalse(snapshot.getBoolean("offer"))
        assertFalse(snapshot.getBoolean("canInstall"))
        assertEquals("beta", snapshot.getString("channel"))
        assertEquals(8192L, snapshot.getLong("bytesDownloaded"))
        val release = snapshot.getJSONObject("available")
        assertEquals("2.0.0-beta.1", release.getString("version"))
        assertEquals("<a>notes</a>", release.getString("notes"))
        assertFalse(release.has("downloadUrl"))
        assertSame(JSONObject.NULL, snapshot.get("error"))
        val rejected = state.copy(ready = false, available = null, error = UpdateError.SIGNATURE_MISMATCH)
            .toBridgeState(true)
        assertSame(JSONObject.NULL, rejected.get("available"))
        assertTrue(rejected.getString("error").orEmpty().contains("signing key"))
    }
}
