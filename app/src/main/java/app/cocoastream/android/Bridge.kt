package app.cocoastream.android

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * The Android side of window.cocoa. Every call from the web UI lands here,
 * runs off the UI thread, and resolves a promise in the page.
 */
class Bridge(private val activity: MainActivity, private val webView: WebView) : PlaybackBus.Listener {
    companion object {
        private val traktInstances = mutableMapOf<String,Trakt>()
        private var castInstance: Cast? = null
        fun caster(context: Context): Cast = synchronized(Bridge::class.java) { castInstance ?: Cast(context.applicationContext).also {castInstance=it} }
    }
    private val trakt: Trakt get() = synchronized(Bridge::class.java) { traktInstances.getOrPut(accounts.profileId) { Trakt(activity.applicationContext,accounts.profileId) } }
    private val cast: Cast = caster(activity)
    private val pool = Executors.newFixedThreadPool(12)
    private val accounts=Accounts(activity)
    private val store = Store(activity) {accounts.profileId}
    private val addons = Addons()
    private val startedAt = System.currentTimeMillis()
    private val startLock = Object()
    private var startOwner: String? = null
    private var startDone = false
    private var startError: String? = null
    private var startCancelled = false

    @JavascriptInterface
    fun invoke(id: Int, method: String, argsJson: String) {
        pool.execute {
            var ok = true
            var payload: String
            try {
                val args = if (argsJson.isBlank() || argsJson == "null") JSONArray() else JSONArray(argsJson)
                payload = toJson(handle(method, args))
            } catch (t: Throwable) {
                ok = false
                payload = JSONObject().put("message", t.message ?: t.javaClass.simpleName).toString()
            }
            reply(id, ok, payload)
        }
    }

    private fun reply(id: Int, ok: Boolean, payload: String) {
        webView.post {
            webView.evaluateJavascript("window.__nativeResolve&&window.__nativeResolve($id,$ok,$payload)", null)
        }
    }

    private fun emit(event: String, detail: JSONObject) {
        webView.post {
            webView.evaluateJavascript(
                "window.__nativeEvent&&window.__nativeEvent(${JSONObject.quote(event)},$detail)",
                null
            )
        }
    }

    private fun toJson(value: Any?): String = when (value) {
        null -> "null"
        is JSONObject -> value.toString()
        is JSONArray -> value.toString()
        is String -> JSONObject.quote(value)
        is Number, is Boolean -> value.toString()
        else -> JSONObject.quote(value.toString())
    }

    private fun handle(method: String, args: JSONArray): Any? {
        return when (method) {
            "auth:session" -> accounts.session()
            "auth:has-accounts" -> accounts.hasAccounts()
            "auth:login" -> accounts.login(args.optString(0),args.optString(1))
            "auth:register" -> accounts.register(args.optString(0),args.optString(1))
            "auth:logout" -> accounts.logout()

            "data:get" -> store.data()
            "data:save" -> store.saveData(args.optJSONObject(0) ?: JSONObject())

            "ratings:list" -> store.ratings()
            "ratings:set" -> store.setRating(args.optString(0), if (args.isNull(1)) null else args.optJSONObject(1))

            "addon:manifest" -> addons.manifest(args.optString(0))
            "addon:request" -> addons.request(args.optJSONObject(0) ?: JSONObject())

            "app:version" -> "1.2.2 (Android)"
            "app:open-external" -> openExternal(args.optString(0))
            "app:write-clipboard" -> writeClipboard(args.optString(0))
            "app:clear-cache" -> clearCache()
            "app:check-updates" -> throw IllegalStateException("Install a newer CocoaStream APK to update. No update server is configured.")

            "playback:native-start" -> nativeStart(args.optJSONObject(0) ?: JSONObject())
            "playback:native-prewarm" -> TorrentPrewarm.prepare(File(activity.cacheDir,"cocoa"),args.optJSONObject(0) ?: JSONObject())
            "playback:native-replace" -> PlayerActivity.current?.replaceSource(args.optJSONObject(0) ?: JSONObject())
                ?: JSONObject().put("ok",false)
            "playback:native-stop" -> stopPlayback(args.optString(0))
            "playback:native-stats" -> PlayerActivity.current?.statsSnapshot() ?: JSONObject()
            "playback:torrent-stats" -> PlayerActivity.current?.torrentStats() ?: JSONObject()
            "playback:native-command" -> PlayerActivity.current?.command(args.optJSONArray(0), args.optString(1))
                ?: JSONObject().put("ok", false)
            "playback:native-add-subtitle" -> PlayerActivity.current?.addSubtitle(args.optJSONObject(0) ?: JSONObject())
                ?: JSONObject().put("ok", false)
            "playback:native-select-subtitle" -> PlayerActivity.current?.selectSubtitle(args.optInt(0, -1))
                ?: JSONObject().put("ok", false)
            "playback:native-surface-controls" -> JSONObject().put("ok", true)
            "playback:warm-report" -> JSONObject()
            "playback:opensub-hash" -> PlayerActivity.current?.subtitleHash()
            "playback:diagnostic-path" -> store.logPath()
            "playback:headers" -> JSONObject().put("ok", true)
            "vpn:status" -> {
                val manager=activity.getSystemService(Context.CONNECTIVITY_SERVICE) as android.net.ConnectivityManager
                val enabled=manager.allNetworks.any { manager.getNetworkCapabilities(it)?.hasTransport(android.net.NetworkCapabilities.TRANSPORT_VPN)==true }
                JSONObject().put("enabled",enabled).put("supported",true)
            }
            "runtime:status" -> JSONObject()
                .put("ready", true)
                .put("engine", "libtorrent4j")
                .put("player", "ExoPlayer")
                .put("uptimeMs", System.currentTimeMillis() - startedAt)
            "subtitle:fetch" -> addons.fetchText(args.optString(0), args.optJSONObject(1))

            "overlay:sync" -> { PlayerActivity.current?.syncControls(args.optJSONObject(0) ?: JSONObject()); JSONObject().put("ok",true) }
            "cast:discover" -> cast.discover()
            "cast:play" -> cast.play(args.optJSONObject(0) ?: JSONObject())
            "cast:stop" -> cast.stop()
            "trakt:status" -> trakt.status()
            "trakt:set-credentials" -> trakt.credentials(args.optJSONObject(0) ?: JSONObject())
            "trakt:start-auth" -> trakt.start()
            "trakt:await-auth" -> trakt.await()
            "trakt:disconnect" -> trakt.disconnect()
            "trakt:scrobble" -> trakt.scrobble(args.optJSONObject(0) ?: JSONObject())
            "trakt:rate" -> trakt.sync("ratings",args.optJSONObject(0) ?: JSONObject(),args.optInt(1))
            "trakt:unrate" -> trakt.sync("ratings/remove",args.optJSONObject(0) ?: JSONObject())
            "trakt:watchlist" -> trakt.sync(if(args.optBoolean(1)) "watchlist" else "watchlist/remove",args.optJSONObject(0) ?: JSONObject())
            "trakt:rated" -> trakt.get("/sync/ratings")
            "trakt:history" -> trakt.get("/sync/history?limit=100")
            "trakt:remote-watchlist" -> trakt.get("/sync/watchlist")
            "trakt:last-activities" -> trakt.get("/sync/last_activities")
            else -> throw IllegalArgumentException("Unknown Android operation: $method")
        }
    }

    private fun nativeStart(payload: JSONObject): Any {
        val ownerId = payload.optString("ownerId")
        val timeout = if (payload.has("loadTimeoutMs")) payload.optLong("loadTimeoutMs") else 60000L
        synchronized(startLock) {
            startOwner = ownerId
            startDone = false
            startError = null
            startCancelled = false
            startLock.notifyAll()
        }
        val intent = Intent(activity, PlayerActivity::class.java)
        intent.putExtra("payload", payload.toString())
        activity.runOnUiThread { synchronized(startLock) { if (startOwner == ownerId && !startCancelled) activity.startActivity(intent) } }
        val deadline = System.currentTimeMillis() + timeout + 5000
        synchronized(startLock) {
            while (!startDone && startOwner == ownerId) {
                val left = deadline - System.currentTimeMillis()
                if (left <= 0) {
                    startDone=true
                    stopPlayback(ownerId)
                    return JSONObject().put("ok", false)
                        .put("failure", JSONObject().put("message", "The source did not open in time."))
                }
                startLock.wait(minOf(left, 500L))
            }
            require(startOwner == ownerId) { "Playback was replaced by a newer request." }
            val error = startError
            if (error != null) {
                return JSONObject().put("ok", false).put("failure", JSONObject().put("message", error).put("code",if(startCancelled) "COCOASTREAM_PLAYBACK_CANCELLED" else "COCOASTREAM_PLAYBACK_FAILED"))
            }
        }
        // native=true tells the renderer a native player owns the surface, so it
        // enters embedded mode instead of falling back to the HTML5 <video> path.
        return JSONObject().put("ok", true).put("ownerId", ownerId).put("native", true)
    }

    private fun stopPlayback(owner: String): JSONObject {
        synchronized(startLock) {
            if(startOwner==owner && !startDone) {startCancelled=true;startDone=true;startError="Playback cancelled.";startLock.notifyAll()}
        }
        activity.runOnUiThread {
            PlayerActivity.current?.let { if (owner.isBlank() || it.owns(owner)) it.finish() }
        }
        return JSONObject().put("ok", true)
    }

    private fun openExternal(url: String): JSONObject {
        require(Uri.parse(url).scheme in listOf("http", "https", "magnet", "stremio")) { "Unsupported external link." }
        return try {
            activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
            JSONObject().put("ok", true)
        } catch (t: Throwable) {
            JSONObject().put("ok", false)
        }
    }

    private fun writeClipboard(text: String): JSONObject {
        val manager = activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        manager.setPrimaryClip(ClipData.newPlainText("CocoaStream", text))
        return JSONObject().put("ok", true)
    }

    private fun clearCache(): JSONObject {
        require(PlayerActivity.current == null) { "Stop playback before clearing the cache." }
        activity.cacheDir?.listFiles()?.forEach { it.deleteRecursively() }
        return JSONObject().put("ok", true)
    }

    override fun onAction(action: JSONObject) { emit("overlay-action",action) }

    override fun onReady(ownerId: String, ms: Long) {
        synchronized(startLock) {
            if (startOwner != ownerId) return
            startDone = true
            startError = null
            startLock.notifyAll()
        }
    }

    override fun onError(ownerId: String, message: String) {
        synchronized(startLock) {
            if (startOwner != ownerId) return
            startDone = true
            startError = message
            startLock.notifyAll()
        }
        emit("native-error", JSONObject().put("ownerId", ownerId).put("message", message))
    }

    override fun onClosed(ownerId: String, position: Long, duration: Long, ended: Boolean) {
        synchronized(startLock) {
            if(startOwner==ownerId && !startDone) {startCancelled=true;startDone=true;startError="Playback cancelled.";startLock.notifyAll()}
        }
        emit(
            "native-closed",
            JSONObject()
                .put("ownerId", ownerId)
                .put("position", position.toDouble())
                .put("duration", duration.toDouble())
                .put("ended", ended)
        )
    }

    override fun onStats(ownerId: String, stats: JSONObject) {
        emit("native-stats", stats)
    }

    fun destroy() { pool.shutdownNow() }

    override fun onStage(ownerId: String, stage: String) {
        emit("engine-status", JSONObject().put("ownerId",ownerId).put("type", "torrent-stage").put("stage", stage))
    }
}

