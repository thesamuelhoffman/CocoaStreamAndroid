package app.cocoastream.android

import android.content.Context
import android.util.AtomicFile
import android.util.Base64
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.PBEKeySpec

/** Local-only profiles. A new install must create its first profile before opening the library. */
class Accounts(private val context:Context) {
    private val file=AtomicFile(File(context.filesDir,"accounts.json"))
    private val preferences=context.getSharedPreferences("local-session",Context.MODE_PRIVATE)
    private fun records():JSONObject = try {JSONObject(String(file.readFully(),Charsets.UTF_8))}catch(_:Exception){JSONObject()}
    private fun derive(password:String,salt:ByteArray):ByteArray = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA1")
        .generateSecret(PBEKeySpec(password.toCharArray(),salt,210000,256)).encoded
    val profileId:String get()=preferences.getString("active","guest") ?: "guest"
    @Synchronized fun session():JSONObject? {
        val id=preferences.getString("active","") ?: ""
        if(id.isEmpty() || id=="guest")return null
        return JSONObject().put("username",id).put("local",true)
    }
    @Synchronized fun hasAccounts():Boolean=records().length()>0
    @Synchronized fun register(username:String,password:String):JSONObject {
        val id=username.trim().lowercase()
        require(id.matches(Regex("[a-z0-9_]{3,24}"))) {"Use 3–24 letters, numbers or underscores for your username."}
        require(id!="guest" && password.length>=8) {"Choose a password with at least 8 characters."}
        val all=records();require(!all.has(id)){"That local username already exists."}
        migrateGuestFiles(id)
        val salt=ByteArray(16).also{SecureRandom().nextBytes(it)}
        all.put(id,JSONObject().put("salt",Base64.encodeToString(salt,Base64.NO_WRAP)).put("hash",Base64.encodeToString(derive(password,salt),Base64.NO_WRAP)))
        val output=file.startWrite()
        try{output.write(all.toString().toByteArray());file.finishWrite(output)}catch(e:Exception){file.failWrite(output);throw e}
        preferences.edit().putString("active",id).commit()
        return session()!!
    }
    private fun migrateGuestFiles(id:String) {
        val profile=File(context.filesDir,"profiles/$id").apply{mkdirs()}
        for(name in listOf("userdata.json","ratings.json")) {
            val source=File(context.filesDir,name)
            val target=File(profile,name)
            if(source.isFile && !target.exists())source.copyTo(target)
        }
    }
    @Synchronized fun login(username:String,password:String):JSONObject {
        val id=username.trim().lowercase()
        val account=records().optJSONObject(id) ?: throw IllegalArgumentException("Username or password is incorrect.")
        val salt=Base64.decode(account.getString("salt"),Base64.NO_WRAP)
        require(MessageDigest.isEqual(derive(password,salt),Base64.decode(account.getString("hash"),Base64.NO_WRAP))){"Username or password is incorrect."}
        preferences.edit().putString("active",id).commit();return session()!!
    }
    @Synchronized fun logout():JSONObject {preferences.edit().putString("active","").commit();return JSONObject().put("ok",true)}
}
