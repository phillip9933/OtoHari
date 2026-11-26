package app.droppedneedle.mobile

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONObject

/** Android 7 can report its installed version without loading the Android 8 updater. */
@CapacitorPlugin(name = "DNUpdates")
class DNUpdatesUnavailablePlugin : Plugin() {
    @PluginMethod
    fun getState(call: PluginCall) {
        @Suppress("DEPRECATION")
        val version = context.packageManager.getPackageInfo(context.packageName, 0).versionName
        call.resolve(JSObject().apply {
            put("supported", false)
            put("installedVersion", version.orEmpty())
            put("channel", "stable")
            put("automaticChecks", false)
            put("wifiDownload", false)
            put("checking", false)
            put("downloading", false)
            put("bytesDownloaded", 0)
            put("ready", false)
            put("offer", false)
            put("lastChecked", 0)
            put("error", JSONObject.NULL)
            put("canInstall", false)
            put("available", JSONObject.NULL)
        })
    }
}
