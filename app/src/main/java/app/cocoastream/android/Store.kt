package app.cocoastream.android

import android.content.Context
import org.json.JSONObject
import org.json.JSONArray
import java.io.File

/** User data (add-ons, history, preferences) and local ratings, as plain JSON files. */
class Store(private val context: Context, private val profile: () -> String = { "guest" }) {
    private fun profileFile(name:String):File {
        val id=profile()
        require(id=="guest" || id.matches(Regex("[a-z0-9_]{3,24}"))){"Sign in to your local profile first."}
        val directory=if(id=="guest") context.filesDir else File(context.filesDir,"profiles/$id").apply{mkdirs()}
        return File(directory,name)
    }
    private val dataFile:File get()=profileFile("userdata.json")
    private val ratingsFile:File get()=profileFile("ratings.json")
    private val lock = Any()

    fun logPath(): String = File(context.filesDir, "cocoastream.log").absolutePath

    fun data(): JSONObject = synchronized(lock) {
        if (!dataFile.exists()) return defaults()
        try {
            val current=JSONObject(String(android.util.AtomicFile(dataFile).readFully(),Charsets.UTF_8))
            if(current.optInt("defaultsVersion",0)<7) {
                val bundled=defaults().optJSONArray("addons") ?: JSONArray()
                val installed=current.optJSONArray("addons") ?: JSONArray()
                val urls=(0 until installed.length()).mapNotNull{installed.optJSONObject(it)?.optString("url")?.takeIf{url->url.isNotBlank()}}.toMutableSet()
                for(i in 0 until bundled.length()) bundled.optJSONObject(i)?.let { addon ->
                    val url=addon.optString("url")
                    if(url.isNotBlank() && urls.add(url))installed.put(JSONObject(addon.toString()))
                }
                current.put("addons",installed).put("defaultsVersion",7)
                saveData(current)
            }
            current
        } catch (t: Throwable) {
            defaults()
        }
    }

    fun saveData(data: JSONObject): JSONObject = synchronized(lock) {
        val atomic = android.util.AtomicFile(dataFile)
        val output=atomic.startWrite()
        try { output.write(data.toString().toByteArray()); atomic.finishWrite(output) }
        catch (e:Exception) {atomic.failWrite(output);throw e}
        data
    }

    fun ratings(): JSONObject = synchronized(lock) {
        if (!ratingsFile.exists()) return JSONObject()
        try {
            JSONObject(ratingsFile.readText())
        } catch (t: Throwable) {
            JSONObject()
        }
    }

    fun setRating(id: String, entry: JSONObject?): JSONObject = synchronized(lock) {
        if (id.isEmpty()) return JSONObject().put("ok", false).put("reason", "invalid")
        val all = ratings()
        if (entry == null) all.remove(id) else all.put(id, entry)
        try {
            val atomic=android.util.AtomicFile(ratingsFile)
            val out=atomic.startWrite()
            try{out.write(all.toString().toByteArray());atomic.finishWrite(out)}catch(e:Exception){atomic.failWrite(out);throw e}
        } catch (t: Throwable) {
            return JSONObject().put("ok", false).put("reason", "unavailable")
        }
        JSONObject().put("ok", true)
    }

    private fun defaults(): JSONObject {
        val text = try {
            context.assets.open("app/defaults.json").bufferedReader().use { it.readText() }
        } catch (t: Throwable) {
            "{}"
        }
        return try {
            JSONObject(text)
        } catch (t: Throwable) {
            JSONObject()
        }
    }
}
