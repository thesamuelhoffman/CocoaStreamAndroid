package app.cocoastream.android

import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * The add-on protocol is plain HTTP + JSON: fetch a manifest, then
 * /{resource}/{type}/{id}/{extra}.json. Doing it natively keeps it out of the
 * WebView's CORS rules and gives us a real timeout.
 */
class Addons {
    private val client = OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(8, TimeUnit.SECONDS)
        .callTimeout(10, TimeUnit.SECONDS)
        .followRedirects(true)
        .followSslRedirects(true)
        .build()

    private val userAgent =
        "Mozilla/5.0 (Linux; Android 13; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) " +
            "Chrome/122.0.0.0 Mobile Safari/537.36 CocoaStream/1.0"

    fun normalizeManifestUrl(input: String): String {
        var value = input.trim()
        require(value.isNotEmpty()) { "Paste an add-on manifest URL." }
        if (value.startsWith("stremio://")) value = "https://" + value.removePrefix("stremio://")
        if (!value.startsWith("http://") && !value.startsWith("https://")) value = "https://$value"
        val uri = android.net.Uri.parse(value)
        var path = uri.path ?: "/"
        if (!path.endsWith("/manifest.json")) path = path.trimEnd('/') + "/manifest.json"
        return uri.buildUpon().path(path).build().toString()
    }

    fun manifest(input: String): JSONObject {
        val url = normalizeManifestUrl(input)
        val json = fetchJson(url)
        if (json !is JSONObject) throw IllegalStateException("That URL did not return an add-on manifest.")
        if (!json.has("id") || !json.has("name")) throw IllegalStateException("That URL did not return an add-on manifest.")
        return JSONObject().put("url", url).put("manifest", json)
    }

    fun request(payload: JSONObject): Any {
        val manifestUrl = payload.optString("manifestUrl")
        val resource = payload.optString("resource")
        val type = payload.optString("type")
        val id = payload.optString("id")
        val extra = payload.optJSONObject("extra") ?: JSONObject()
        return fetchJson(buildResourceUrl(manifestUrl, resource, type, id, extra))
    }

    fun buildResourceUrl(manifestUrl: String, resource: String, type: String, id: String, extra: JSONObject): String {
        val base = normalizeManifestUrl(manifestUrl).replace(Regex("/manifest\\.json(\\?.*)?$"), "")
        val pairs = StringBuilder()
        for (key in extra.keys()) {
            val value = extra.opt(key)
            if (value == null || value == JSONObject.NULL || value.toString().isEmpty()) continue
            if (pairs.isNotEmpty()) pairs.append('&')
            pairs.append(java.net.URLEncoder.encode(key, "UTF-8"))
                .append('=')
                .append(java.net.URLEncoder.encode(value.toString(), "UTF-8"))
        }
        val tail = if (pairs.isNotEmpty()) "/$pairs.json" else ".json"
        return "$base/$resource/${java.net.URLEncoder.encode(type, "UTF-8")}/${java.net.URLEncoder.encode(id, "UTF-8")}$tail"
    }

    fun fetchJson(url: String): Any {
        val request = Request.Builder().url(url).header("User-Agent", userAgent).header("Accept", "application/json").build()
        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) throw IllegalStateException("HTTP ${response.code} from add-on.")
            val body = response.body?.string() ?: "{}"
            val trimmed = body.trim()
            return if (trimmed.startsWith("[")) JSONArray(trimmed) else JSONObject(trimmed)
        }
    }

    /**
     * Raw bytes. fetchText decodes the body as text, which mangles anything
     * binary (a WOFF font comes back as replacement characters and the font
     * silently never loads), so binary callers use this instead.
     */
    fun fetchBytes(url: String, headers: JSONObject?): ByteArray {
        val builder = Request.Builder().url(url).header("User-Agent", userAgent)
        headers?.let { for (key in it.keys()) builder.header(key, it.optString(key)) }
        client.newCall(builder.build()).execute().use { response ->
            if (!response.isSuccessful) throw IllegalStateException("HTTP ${response.code}")
            return response.body?.bytes() ?: ByteArray(0)
        }
    }

    fun fetchText(url: String, headers: JSONObject?): String {
        val builder = Request.Builder().url(url).header("User-Agent", userAgent)
        headers?.let { for (key in it.keys()) builder.header(key, it.optString(key)) }
        client.newCall(builder.build()).execute().use { response ->
            if (!response.isSuccessful) throw IllegalStateException("HTTP ${response.code}")
            return response.body?.string() ?: ""
        }
    }
}
