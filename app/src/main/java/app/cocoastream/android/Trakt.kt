package app.cocoastream.android

import android.content.Context
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.MediaType.Companion.toMediaType
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/** Native device OAuth and sync. Refresh and token rotation are serialized. */
class Trakt(context: Context,profile:String) {
    private val secrets = Secrets(context,profile)
    private var state = secrets.read()
    private var deviceCode = ""
    private var pollSeconds = 5L
    private var expiresAt = 0L
    private var lastScrobble = 0L
    private val http = OkHttpClient.Builder().callTimeout(12,TimeUnit.SECONDS).build()
    @Synchronized fun status() = JSONObject().put("configured",state.optString("clientId").isNotBlank())
        .put("connected",state.optString("access_token").isNotBlank()).put("clientId",state.optString("clientId"))
    @Synchronized fun credentials(input: JSONObject): JSONObject {
        val id=input.optString("clientId").trim()
        require(id.isNotEmpty()) { "Enter your Trakt client ID." }
        if (id != state.optString("clientId")) state=JSONObject()
        state.put("clientId",id)
        if(input.optString("clientSecret").isNotEmpty()) state.put("clientSecret",input.optString("clientSecret"))
        secrets.write(state); return status()
    }
    private fun request(path:String, body:JSONObject?=null, auth:Boolean=true): Any {
        if(auth) refresh()
        val b=Request.Builder().url("https://api.trakt.tv$path")
            .header("trakt-api-version","2").header("trakt-api-key",state.optString("clientId"))
        if(auth) {
            require(state.optString("access_token").isNotBlank()) { "Connect Trakt first." }
            b.header("Authorization","Bearer ${state.optString("access_token")}")
        }
        if(body!=null)b.post(body.toString().toRequestBody("application/json".toMediaType()))
        http.newCall(b.build()).execute().use { response ->
            val text=response.body?.string().orEmpty()
            if(!response.isSuccessful) throw TraktError(response.code)
            return if(text.trimStart().startsWith("[")) JSONArray(text) else if(text.isBlank()) JSONObject() else JSONObject(text)
        }
    }
    private fun keep(tokens:JSONObject) {
        require(tokens.optString("access_token").isNotBlank() && tokens.optString("refresh_token").isNotBlank()) { "Invalid Trakt session." }
        val next=JSONObject(state.toString())
        for(k in listOf("access_token","refresh_token","created_at","expires_in"))next.put(k,tokens.opt(k))
        secrets.write(next); state=next
    }
    private fun refresh() {
        if(state.optString("access_token").isBlank())return
        val expiry=(state.optLong("created_at")+state.optLong("expires_in"))*1000
        if(expiry > System.currentTimeMillis()+60000)return
        try {
            keep(request("/oauth/token",JSONObject().put("refresh_token",state.optString("refresh_token"))
                .put("client_id",state.optString("clientId")).put("client_secret",state.optString("clientSecret"))
                .put("redirect_uri","urn:ietf:wg:oauth:2.0:oob").put("grant_type","refresh_token"),false) as JSONObject)
        } catch(e:TraktError) { if(e.status in listOf(400,401,403))disconnect();throw e }
    }
    @Synchronized fun start(): JSONObject {
        require(state.optString("clientId").isNotBlank()) { "Save your Trakt client ID first." }
        val code=request("/oauth/device/code",JSONObject().put("client_id",state.optString("clientId")),false) as JSONObject
        deviceCode=code.getString("device_code");pollSeconds=code.optLong("interval",5).coerceAtLeast(5)
        expiresAt=System.currentTimeMillis()+code.optLong("expires_in",600)*1000
        return JSONObject().put("userCode",code.getString("user_code")).put("verificationUrl",code.getString("verification_url"))
            .put("interval",pollSeconds).put("expiresIn",code.optLong("expires_in",600))
    }
    fun await(): JSONObject {
        while(System.currentTimeMillis()<expiresAt) {
            Thread.sleep(pollSeconds*1000)
            synchronized(this) {
                if(deviceCode.isEmpty())throw IllegalStateException("Trakt sign-in cancelled.")
                try {
                    keep(request("/oauth/device/token",JSONObject().put("code",deviceCode).put("client_id",state.optString("clientId"))
                        .put("client_secret",state.optString("clientSecret")),false) as JSONObject)
                    deviceCode="";return status()
                } catch(e:TraktError) { if(e.status==429)pollSeconds+=5 else if(e.status!=400)throw e }
            }
        }
        throw IllegalStateException("Trakt sign-in expired. Try again.")
    }
    @Synchronized fun disconnect():JSONObject {
        state.remove("access_token");state.remove("refresh_token");deviceCode="";secrets.write(state);return status()
    }
    private fun media(input:JSONObject):Pair<String,JSONObject> {
        val imdb=input.optString("id").substringBefore(':')
        require(imdb.matches(Regex("tt[0-9]+"))) { "This title has no IMDb ID for Trakt." }
        return if(input.optString("type")=="series" && input.has("season") && input.has("episode"))
            "show" to JSONObject().put("ids",JSONObject().put("imdb",imdb))
        else if(input.optString("type")=="series") "show" to JSONObject().put("ids",JSONObject().put("imdb",imdb))
        else "movie" to JSONObject().put("ids",JSONObject().put("imdb",imdb))
    }
    @Synchronized fun scrobble(p:JSONObject):Any {
        if(!status().optBoolean("connected"))return JSONObject().put("skipped",true)
        val action=if(p.optBoolean("ended") || !p.optBoolean("watching",true)) "stop" else if(p.optBoolean("paused")) "pause" else "start"
        if(action=="start" && System.currentTimeMillis()-lastScrobble<15000)return JSONObject().put("skipped",true)
        val input=p.optJSONObject("media") ?: return JSONObject().put("skipped",true)
        val (kind,item)=media(input)
        val body=JSONObject().put(kind,item).put("progress",p.optDouble("progress",0.0).coerceIn(0.0,100.0))
        if(kind=="show" && input.has("season"))body.put("episode",JSONObject().put("season",input.optInt("season")).put("number",input.optInt("episode")))
        lastScrobble=System.currentTimeMillis();return request("/scrobble/$action",body)
    }
    @Synchronized fun sync(action:String,input:JSONObject,rating:Int=0):Any {
        val (kind,item)=media(input)
        if(rating>0)item.put("rating",rating.coerceIn(1,10))
        return request("/sync/$action",JSONObject().put(if(kind=="show") "shows" else "movies",JSONArray().put(item)))
    }
    @Synchronized fun get(path:String):Any = request(path)
    class TraktError(val status:Int):Exception("Trakt returned HTTP $status.")
}
