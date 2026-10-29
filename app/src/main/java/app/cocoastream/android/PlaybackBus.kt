package app.cocoastream.android

import org.json.JSONObject

/**
 * The one channel between the native player and the web UI.
 * MainActivity installs the bridge as the listener; PlayerActivity emits.
 */
object PlaybackBus {
    interface Listener {
        fun onAction(action: JSONObject)
        fun onReady(ownerId: String, ms: Long)
        fun onError(ownerId: String, message: String)
        fun onClosed(ownerId: String, position: Long, duration: Long, ended: Boolean)
        fun onStats(ownerId: String, stats: JSONObject)
        fun onStage(ownerId: String, stage: String)
    }

    @Volatile
    var listener: Listener? = null
}
