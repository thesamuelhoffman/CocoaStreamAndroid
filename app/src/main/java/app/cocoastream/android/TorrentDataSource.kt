package app.cocoastream.android

import android.net.Uri
import android.util.Log
import androidx.media3.common.C
import androidx.media3.datasource.BaseDataSource
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec

/** Feeds ExoPlayer straight from the torrent download, no local HTTP server. */
class TorrentDataSource(private val engine: TorrentEngine) : BaseDataSource(true) {
    private val tag = "CocoaStreamSource"

    companion object {
        private const val FIRST_READ_WAIT_MS = 18_000L
        private const val STALL_WAIT_MS = 25_000L
        // Demuxers seek to the very end of the file (moov atom, Matroska Cues)
        // before they paint anything. That read is a few MiB; if it has not
        // arrived in 12s the swarm is not going to serve it, and waiting the
        // full 25s twice cost a measured 33s on a 10 GB source before the
        // failover even started.
        private const val TAIL_READ_WAIT_MS = 12_000L
        private const val TAIL_WINDOW_BYTES = 16L * 1024 * 1024
    }
    private var position = 0L
    private var remaining = 0L
    private var uri: Uri? = null

    override fun open(dataSpec: DataSpec): Long {
        transferInitializing(dataSpec)
        position = dataSpec.position
        remaining = engine.fileSize - position
        uri = dataSpec.uri
        Log.i(tag, "open position=$position size=${engine.fileSize} remaining=$remaining")
        transferStarted(dataSpec)
        return if (remaining > 0) remaining else 0
    }

    override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
        if (length == 0) return 0
        if (remaining <= 0) return C.RESULT_END_OF_INPUT
        val want = minOf(length.toLong(), remaining).toInt()
        // readAt throws on a stall so the player fails over instead of hanging.
        // The first read gets a tighter budget: a source whose first piece never
        // arrives is a dud, and burning 45s on it eats the whole retry budget.
        val wait = when {
            position == 0L -> FIRST_READ_WAIT_MS
            position >= engine.fileSize - TAIL_WINDOW_BYTES -> TAIL_READ_WAIT_MS
            else -> STALL_WAIT_MS
        }
        val read = engine.readAt(position, buffer, offset, want, wait)
        if (read < 0) return C.RESULT_END_OF_INPUT
        if (read == 0) throw java.io.IOException("no bytes available at $position")
        position += read
        remaining -= read
        bytesTransferred(read)
        return read
    }

    override fun getUri(): Uri? = uri

    override fun close() {
        uri = null
        transferEnded()
    }

    class Factory(private val engine: TorrentEngine) : DataSource.Factory {
        override fun createDataSource(): DataSource = TorrentDataSource(engine)
    }
}
