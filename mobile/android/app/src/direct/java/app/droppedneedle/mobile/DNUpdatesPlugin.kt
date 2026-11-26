package app.droppedneedle.mobile

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.annotation.RequiresApi
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import io.github.phillip9933.appupdater.AndroidUpdateChannel
import io.github.phillip9933.appupdater.UpdateConfig
import io.github.phillip9933.appupdater.UpdateError
import io.github.phillip9933.appupdater.UpdateManager
import io.github.phillip9933.appupdater.UpdateState
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONObject

internal val dnUpdateConfig = UpdateConfig(
    owner = "phillip9933",
    repository = "OtoHari",
    tagPrefix = "android-v",
    assetPrefix = "droppedneedle-android-",
)

@RequiresApi(Build.VERSION_CODES.O)
@CapacitorPlugin(name = "DNUpdates")
class DNUpdatesPlugin : Plugin() {
    private lateinit var updates: UpdateManager
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var observer: Job? = null
    private val installWindow = ForegroundUpdateInstall()

    // Only the transfer survives Activity recreation. It holds the SDK's application context.
    private companion object {
        val transferScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        var manualDownload: Deferred<Unit>? = null
    }

    override fun load() {
        updates = UpdateManager.get(context.applicationContext, dnUpdateConfig)
        updates.initialize()
    }

    override fun handleOnResume() {
        installWindow.resume()
        observer?.cancel()
        val canInstall = canInstallPackages()
        observer = scope.launch {
            updates.state.collect { state ->
                notifyListeners("updateState", state.toBridgeState(canInstall))
                // Byte progress can arrive many times in a single WebView frame.
                if (state.downloading) delay(150)
            }
        }
    }

    override fun handleOnPause() {
        installWindow.pause()
        observer?.cancel()
    }

    override fun handleOnDestroy() {
        installWindow.pause()
        scope.cancel()
    }

    @PluginMethod
    fun getState(call: PluginCall) {
        call.resolve(updates.state.value.toBridgeState(canInstallPackages()))
    }

    @PluginMethod
    fun check(call: PluginCall) = change(call) {
        if (!updates.state.value.downloading && !updates.state.value.checking) updates.checkNow()
    }

    @PluginMethod
    fun setPreferences(call: PluginCall) = change(call) {
        val channel = when (call.data.opt("channel")) {
            null -> null
            "stable" -> AndroidUpdateChannel.STABLE
            "beta" -> AndroidUpdateChannel.BETA
            else -> fail("Choose the stable or beta release channel.")
        }
        val automatic = call.booleanSetting("automaticChecks")
        val wifi = call.booleanSetting("wifiDownload")
        val channelChanged = channel != null && channel != updates.state.value.channel
        if (channelChanged) {
            manualDownload?.cancel()
            updates.setChannel(checkNotNull(channel))
        }
        automatic?.let(updates::setAutomaticChecks)
        wifi?.let(updates::setWifiDownload)
        if (channelChanged && updates.state.value.automaticChecks) updates.checkNow(force = false)
    }

    @PluginMethod
    fun download(call: PluginCall) = change(call) {
        val state = updates.state.value
        selectedTag(call, state)
        if (state.ready || state.downloading) return@change
        if (state.checking) fail("Wait for the release check to finish and tap Download again.")
        val manager = updates
        val transfer = manualDownload?.takeIf { it.isActive }
            ?: transferScope.async { manager.download() }.also { manualDownload = it }
        transfer.await()
    }

    @PluginMethod
    fun cancelDownload(call: PluginCall) = change(call) {
        if (manualDownload?.isActive == true || updates.state.value.downloading) {
            updates.cancelDownload()
            manualDownload?.cancel()
        }
    }

    @PluginMethod
    fun dismiss(call: PluginCall) = change(call) {
        synchronized(updates) {
            selectedTag(call, updates.state.value)
            updates.dismissOffer()
        }
    }

    @PluginMethod
    fun openInstallSettings(call: PluginCall) = change(call) {
        requireForeground()
        if (!updates.state.value.ready) fail("Download and verify an update first.")
        if (!canInstallPackages()) {
            val page = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.fromParts("package", context.packageName, null))
            activity.startActivity(page)
        }
    }

    @PluginMethod
    fun install(call: PluginCall) = change(call) {
        requireForeground()
        val state = updates.state.value
        val tag = selectedTag(call, state)
        if (!state.ready || state.downloading) fail("Download and verify this update first.")
        if (!canInstallPackages()) fail("Allow OtoHari to install apps, then tap Install again.")
        val intent = installWindow.prepare {
            updates.prepareInstall()
                ?: fail(updates.state.value.error?.description() ?: "Android could not open an installer for this update.")
        }
        requireForeground()
        val current = updates.state.value
        if (!current.ready || current.available?.tag != tag) fail("The available release changed. Review it again.")
        if (!canInstallPackages()) fail("Allow OtoHari to install apps, then tap Install again.")
        activity.startActivity(intent)
    }

    private fun requireForeground() {
        if (!installWindow.resumed || activity.isFinishing || activity.isDestroyed) fail("Return to App updates and tap again.")
    }

    private fun canInstallPackages(): Boolean = try {
        context.packageManager.canRequestPackageInstalls()
    } catch (_: SecurityException) {
        false
    }

    private fun selectedTag(call: PluginCall, state: UpdateState): String {
        val tag = call.getString("tag")
        if (tag == null || tag != state.available?.tag) fail("The available release changed. Review it again.")
        return tag
    }

    private fun PluginCall.booleanSetting(key: String): Boolean? =
        if (data.has(key)) getBoolean(key) ?: fail("Choose on or off for this setting.") else null

    private fun change(call: PluginCall, action: suspend () -> Unit) {
        scope.launch {
            try {
                action()
                call.resolve()
            } catch (cancelled: CancellationException) {
                // A separate Cancel download tap also completes the original download call.
                if (isActive) call.resolve()
                throw cancelled
            } catch (failure: UpdateActionFailure) {
                call.reject(failure.message)
            } catch (_: ActivityNotFoundException) {
                call.reject("Android could not open the requested system screen.")
            } catch (_: SecurityException) {
                call.reject("Android blocked this action. Check the app installation permission.")
            } catch (_: Exception) {
                call.reject("Android could not complete the update. Try again.")
            }
        }
    }
}

private class UpdateActionFailure(message: String) : Exception(message)
private fun fail(message: String): Nothing = throw UpdateActionFailure(message)

/** An install tap is valid only while the same Activity stays continuously resumed. Main thread only. */
internal class ForegroundUpdateInstall {
    var resumed = false
        private set
    private var pending: Any? = null

    fun resume() { resumed = true }

    fun pause() {
        resumed = false
        pending = null
    }

    suspend fun <T> prepare(verify: suspend () -> T): T {
        if (!resumed) fail("Return to App updates and tap Install again.")
        if (pending != null) fail("Android is already preparing this update.")
        val tap = Any()
        pending = tap
        try {
            val result = verify()
            if (pending !== tap) fail("Return to App updates and tap Install again.")
            return result
        } finally {
            if (pending === tap) pending = null
        }
    }
}

internal fun UpdateState.toBridgeState(canInstall: Boolean): JSObject = JSObject().apply {
    put("supported", true)
    put("installedVersion", installedVersion)
    put("channel", channel.name.lowercase())
    put("automaticChecks", automaticChecks)
    put("wifiDownload", wifiDownload)
    put("checking", checking)
    put("downloading", downloading)
    put("bytesDownloaded", bytesDownloaded)
    put("ready", ready)
    put("offer", offer)
    put("lastChecked", lastChecked)
    put("error", error?.description() ?: JSONObject.NULL)
    put("canInstall", canInstall)
    put("available", available?.let { release ->
        JSObject().apply {
            put("tag", release.tag)
            put("version", dnUpdateConfig.versionFromTag(release.tag))
            put("sizeBytes", release.sizeBytes)
            put("notes", release.notes.take(8000))
        }
    } ?: JSONObject.NULL)
}

private fun UpdateError.description(): String? = when (this) {
    UpdateError.NETWORK -> "Could not reach GitHub to check for updates. Try again later."
    UpdateError.INVALID_RELEASE -> "The GitHub release does not contain a valid Android update."
    UpdateError.DOWNLOAD_FAILED -> "The APK download failed. Check your connection and retry."
    UpdateError.SIZE_MISMATCH, UpdateError.HASH_MISMATCH -> "The download differs from the published APK. Download it again."
    UpdateError.INVALID_APK -> "Android could not read the downloaded APK."
    UpdateError.WRONG_PACKAGE -> "The downloaded APK belongs to another app."
    UpdateError.DEBUG_APK -> "The published APK is a debug build. A release build is required."
    UpdateError.INCOMPATIBLE_SDK -> "This update requires a newer version of Android."
    UpdateError.OLD_VERSION -> "Android already has this version or a newer one."
    UpdateError.VERSION_MISMATCH -> "The APK version differs from the GitHub release."
    UpdateError.SIGNATURE_MISMATCH -> "This APK uses a different signing key from the installed app."
    UpdateError.STORAGE -> "Could not store or read the update. Check available space and retry."
    UpdateError.CANCELLED -> null
}
