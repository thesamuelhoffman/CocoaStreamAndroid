package app.cocoastream.android

import android.content.Context
import android.graphics.Typeface
import android.os.Handler
import android.os.Looper
import android.util.Log
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.zip.Inflater

/**
 * CocoaStream's UI font is fetched at runtime from the same upstream URL the
 * web UI uses (it is not redistributed in this package). Android's Typeface
 * only reads TTF/OTF, so the WOFF is unpacked here: WOFF 1.0 is just an sfnt
 * with zlib-compressed tables, and writing it back out is mechanical.
 */
object SubtitleFont {
    private const val TAG = "CocoaStreamFont"
    private const val URL =
        "https://raw.githubusercontent.com/Mojang/web-theme-bootstrap/main/assets/fonts/Minecraft-Seven_v2.woff"

    @Volatile private var cached: Typeface? = null
    @Volatile private var started = false
    private val waiting = ArrayList<(Typeface?) -> Unit>()

    private fun file(context: Context): File =
        File(File(context.filesDir, "fonts").apply { mkdirs() }, "Minecraft-Seven_v2.ttf")

    /**
     * Disk only, no network: safe on the main thread. The download used to
     * happen right here inside applySubtitleStyle(), i.e. on the main thread,
     * which threw NetworkOnMainThreadException - an exception whose message is
     * null, so the log only ever said "font fetch failed: null".
     */
    fun peek(context: Context): Typeface? {
        cached?.let { return it }
        val ttf = file(context)
        if (!ttf.exists()) return null
        cached = try {
            Typeface.createFromFile(ttf)
        } catch (t: Throwable) {
            Log.w(TAG, "font load failed: ${t.javaClass.simpleName}: ${t.message}")
            null
        }
        // Proof the pixel font is really applied instead of silently falling
        // back to the system face: one line, either way.
        if (cached != null) Log.i(TAG, "font ready ${ttf.length()} bytes")
        return cached
    }

    /** Downloads once, off the main thread, then calls back on the main thread. */
    fun load(context: Context, onReady: (Typeface?) -> Unit) {
        peek(context)?.let { onReady(it); return }
        val app = context.applicationContext
        synchronized(this) {
            waiting.add(onReady)
            if (started) return
            started = true
        }
        Thread {
            val face = fetch(app)
            Handler(Looper.getMainLooper()).post {
                val callbacks = synchronized(this) {
                    val copy = ArrayList(waiting)
                    waiting.clear()
                    copy
                }
                for (cb in callbacks) {
                    try { cb(face) } catch (t: Throwable) { Log.w(TAG, "font callback failed: ${t.message}") }
                }
            }
        }.start()
    }

    private fun fetch(context: Context): Typeface? {
        val ttf = file(context)
        if (!ttf.exists()) {
            try {
                val woff = Addons().fetchBytes(URL, null)
                Log.i(TAG, "font downloaded ${woff.size} bytes")
                val converted = woffToTtf(woff)
                if (converted != null && converted.size > 1024) {
                    ttf.writeBytes(converted)
                    Log.i(TAG, "font converted ${converted.size} bytes")
                } else {
                    Log.w(TAG, "font convert failed: woff=${woff.size} bytes")
                }
            } catch (t: Throwable) {
                // Null messages happen; the class name is what identifies it.
                Log.w(TAG, "font fetch failed: ${t.javaClass.simpleName}: ${t.message}", t)
            }
        }
        if (!ttf.exists()) {
            Log.w(TAG, "font unavailable, subtitles use the system face")
            return null
        }
        val face = try {
            Typeface.createFromFile(ttf)
        } catch (t: Throwable) {
            Log.w(TAG, "font load failed: ${t.javaClass.simpleName}: ${t.message}")
            null
        }
        if (face != null) {
            cached = face
            Log.i(TAG, "font ready ${ttf.length()} bytes")
        }
        return face
    }

    private fun u16(b: ByteArray, o: Int): Int = ((b[o].toInt() and 0xFF) shl 8) or (b[o + 1].toInt() and 0xFF)
    private fun u32(b: ByteArray, o: Int): Long =
        ((b[o].toLong() and 0xFF) shl 24) or ((b[o + 1].toLong() and 0xFF) shl 16) or
            ((b[o + 2].toLong() and 0xFF) shl 8) or (b[o + 3].toLong() and 0xFF)

    private fun woffToTtf(woff: ByteArray): ByteArray? {
        if (woff.size < 44) return null
        if (String(woff, 0, 4, Charsets.ISO_8859_1) != "wOFF") return null
        val numTables = u16(woff, 12)
        if (numTables <= 0 || numTables > 512) return null

        class Entry(val tag: ByteArray, val offset: Int, val compLength: Int, val origLength: Int, val checksum: Long)

        val entries = ArrayList<Entry>(numTables)
        for (i in 0 until numTables) {
            val base = 44 + i * 20
            if (base + 20 > woff.size) return null
            val tag = woff.copyOfRange(base, base + 4)
            entries.add(
                Entry(
                    tag = tag,
                    offset = u32(woff, base + 4).toInt(),
                    compLength = u32(woff, base + 8).toInt(),
                    origLength = u32(woff, base + 12).toInt(),
                    checksum = u32(woff, base + 16)
                )
            )
        }

        val tables = HashMap<String, ByteArray>()
        for (e in entries) {
            if (e.offset + e.compLength > woff.size) return null
            val raw = woff.copyOfRange(e.offset, e.offset + e.compLength)
            val data = if (e.compLength == e.origLength) raw else inflate(raw, e.origLength) ?: return null
            tables[String(e.tag, Charsets.ISO_8859_1)] = data
        }

        // sfnt header
        var offset = 12 + numTables * 16
        val out = ByteArrayOutputStream(offset + tables.values.sumOf { ((it.size + 3) / 4) * 4 })
        fun w16(v: Int) { out.write((v shr 8) and 0xFF); out.write(v and 0xFF) }
        fun w32(v: Long) { w16(((v shr 16) and 0xFFFF).toInt()); w16((v and 0xFFFF).toInt()) }

        val sorted = entries.sortedBy { String(it.tag, Charsets.ISO_8859_1) }
        var searchRange = 1
        var entrySelector = 0
        while (searchRange * 2 <= numTables) { searchRange *= 2; entrySelector++ }
        searchRange *= 16

        w32(0x00010000L)
        w16(numTables)
        w16(searchRange)
        w16(entrySelector)
        w16(numTables * 16 - searchRange)

        val dataOffsets = HashMap<String, Int>()
        for (e in sorted) {
            val key = String(e.tag, Charsets.ISO_8859_1)
            val data = tables[key] ?: return null
            out.write(e.tag)
            w32(e.checksum)
            w32(offset.toLong())
            w32(data.size.toLong())
            dataOffsets[key] = offset
            offset += ((data.size + 3) / 4) * 4
        }
        for (e in sorted) {
            val key = String(e.tag, Charsets.ISO_8859_1)
            val data = tables[key] ?: return null
            out.write(data)
            var pad = (4 - (data.size % 4)) % 4
            while (pad-- > 0) out.write(0)
        }
        return out.toByteArray()
    }

    private fun inflate(raw: ByteArray, expected: Int): ByteArray? {
        val inflater = Inflater()
        return try {
            inflater.setInput(raw)
            val buffer = ByteArray(expected)
            var total = 0
            while (total < expected) {
                val n = inflater.inflate(buffer, total, expected - total)
                if (n == 0) {
                    if (inflater.finished() || inflater.needsInput() || inflater.needsDictionary()) break
                } else {
                    total += n
                }
            }
            if (total == expected) buffer else null
        } catch (t: Throwable) {
            null
        } finally {
            inflater.end()
        }
    }
}
