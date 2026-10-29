package app.cocoastream.android

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Tokens stay in app-private, Keystore-encrypted storage, never in the page or backup. */
class Secrets(context: Context,profile:String) {
    private val file = AtomicFile(File(context.noBackupFilesDir, "trakt-${profile.ifEmpty {"guest"}}.enc"))
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey("cocoa.trakt", null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder("cocoa.trakt", KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }
    @Synchronized fun read(): JSONObject = try {
        val data = file.readFully()
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, data.copyOfRange(0,12)))
        JSONObject(String(cipher.doFinal(data.copyOfRange(12,data.size)), Charsets.UTF_8))
    } catch (_: Exception) { JSONObject() }
    @Synchronized fun write(value: JSONObject) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val out = file.startWrite()
        try { out.write(cipher.iv); out.write(cipher.doFinal(value.toString().toByteArray())); file.finishWrite(out) }
        catch (e: Exception) { file.failWrite(out); throw e }
    }
    @Synchronized fun clear() { file.delete() }
}
