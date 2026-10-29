package app.cocoastream.android

import android.util.Log
import org.json.JSONObject
import org.libtorrent4j.AddTorrentParams
import org.libtorrent4j.Priority
import org.libtorrent4j.SessionManager
import org.libtorrent4j.Sha1Hash
import org.libtorrent4j.TorrentHandle
import org.libtorrent4j.swig.torrent_flags_t
import org.libtorrent4j.TorrentInfo
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile
import java.util.concurrent.atomic.AtomicBoolean

/**
 * One torrent, one playing file, read straight out of the download as it lands.
 *
 * Streaming shape (measured on the desktop build): an MKV demuxer reads the
 * head and also jumps to the tail for Cues before it paints a frame, so the
 * head (8 MiB) and the tail (4 MiB) are given top piece priority immediately
 * and the rest runs sequentially. Without the tail warm, cold start on a
 * 3-8 GB file stalls for tens of seconds.
 */
class TorrentEngine(private val rootDir: File) {
    companion object {
        private const val TAG = "CocoaStreamTorrent"
        // Measured on the emulator (cold app data, one core): the tail warm is
        // what decides whether a movie paints at all, and 8 MiB of tail plus
        // 8 MiB of head does not arrive inside Sam's 50s bar on a 250-600 KB/s
        // swarm - "tail ready=false after=10913ms" and then the demuxer sat at
        // position=size-107KB until the budget ran out. The demuxer only needs
        // the index at the very end (~110 KB on a 1.7 GB MKV), so the tail warm
        // is now 1 MiB and gets a piece deadline; the head warm is 2 MiB, which
        // is enough to parse and start, and readAt() extends it as playback runs.
        private const val HEAD_WARM_BYTES = 2L * 1024 * 1024
        // Big enough to cover a whole MP4 moov that sits at the end of the file.
        // Measured on Obsession (build28/29): the demuxer asked for the last
        // 6,784,467 bytes of a 5.3 GB MP4, while the tail warm covered only 4 MiB
        // (one piece), so part of the request was never prioritised.
        private const val TAIL_WARM_BYTES = 24L * 1024 * 1024
        // How long to wait for the piece at the end of the file (MKV Cues /
        // MP4 moov) before giving up on the source.
        private const val TAIL_WAIT_MS = 3000L
        private val TRACKERS = listOf(
            "udp://tracker.opentrackr.org:1337/announce",
            "udp://open.demonii.com:1337/announce",
            "udp://open.stealth.si:80/announce",
            "udp://tracker.torrent.eu.org:451/announce",
            "udp://exodus.desync.com:6969/announce",
            "udp://tracker.openbittorrent.com:6969/announce",
            "udp://tracker.dler.org:6969/announce",
            "udp://opentracker.i2p.rocks:6969/announce",
            "https://tracker.tamersunion.org:443/announce",
            "wss://tracker.openwebtorrent.com"
        )
    }

    private var session: SessionManager? = null
    private var handle: TorrentHandle? = null
    @Volatile private var info: TorrentInfo? = null
    @Volatile private var file: File? = null
    @Volatile private var raf: RandomAccessFile? = null
    @Volatile var fileSize: Long = 0L
        private set
    @Volatile var fileIndex: Int = -1
        private set
    private var fileOffset: Long = 0L
    private var pieceLength: Int = 0
    private var resolvedVideoName = ""
    private val stopped = AtomicBoolean(false)
    @Volatile var metadataMs: Long = 0L
        private set
    @Volatile var resolvedPath: File? = null
        private set
    @Volatile var lastReadMs: Long = 0L
        private set
    @Volatile var firstByteMs: Long = 0L
        private set
    private var diagThread: Thread? = null
    private var startMs = 0L

    fun magnetFor(infoHash: String, stream: JSONObject): String {
        val builder = StringBuilder("magnet:?xt=urn:btih:").append(infoHash.lowercase())
        val name = stream.optString("name").ifEmpty { stream.optString("title") }
        if (name.isNotEmpty()) builder.append("&dn=").append(java.net.URLEncoder.encode(name, "UTF-8"))
        val sources = stream.optJSONArray("sources")
        val extra = ArrayList<String>()
        if (sources != null) {
            for (i in 0 until sources.length()) {
                val s = sources.optString(i)
                if (s.startsWith("tracker:")) extra.add(s.removePrefix("tracker:"))
            }
        }
        for (tracker in TRACKERS + extra) builder.append("&tr=").append(java.net.URLEncoder.encode(tracker, "UTF-8"))
        return builder.toString()
    }

    /** Pulls the btih hash out of a magnet uri. */
    private var payloadDir: File? = null

    private fun magnetHash(magnet: String): String {
        val marker = "urn:btih:"
        val at = magnet.indexOf(marker)
        if (at < 0) throw IllegalArgumentException("magnet uri has no btih hash")
        val rest = magnet.substring(at + marker.length)
        val end = rest.indexOf('&')
        return if (end < 0) rest else rest.substring(0, end)
    }

    /** Adds the torrent and blocks until metadata + the playing file are known. */
    fun start(magnet: String, wantedIndex: Int?, timeoutMs: Long = 45000, season: Int = -1, episode: Int = -1) {
        val startedAt = System.currentTimeMillis()
        startMs = startedAt
        val hashHex = magnetHash(magnet)
        val parent = File(rootDir, "torrents").apply { mkdirs() }
        // One payload on disk at a time. Every source attempt preallocates the
        // whole video file before it downloads a byte, and the emulator's data
        // partition is 16 GB: a 5.3 GB MP4 attempt, then a 2.9 GB MKV attempt,
        // then a third, and the partition is full. Measured on run22: the swarm
        // pulled 2.7 MB/s from 23 peers while done stayed at exactly one piece,
        // which is what a failed write looks like. Each attempt also gets its own
        // folder so two sources of the same movie can never write the same path.
        val dir = File(parent, hashHex + "-" + java.util.UUID.randomUUID()).apply { mkdirs() }
        payloadDir = dir
        val s = SessionManager()
        session = s
        s.start()
        val hash = Sha1Hash.parseHex(hashHex)
        s.download(magnet, dir, torrent_flags_t())
        var added: TorrentHandle? = null
        while (System.currentTimeMillis() < startedAt + 10000 && !stopped.get()) {
            val found = s.find(hash)
            if (found != null && found.isValid()) { added = found; break }
            Thread.sleep(100)
        }
        val h: TorrentHandle = added ?: throw IllegalStateException("The torrent could not be added.")
        handle = h

        val deadline = startedAt + timeoutMs
        var ti: TorrentInfo? = null
        while (System.currentTimeMillis() < deadline && !stopped.get()) {
            ti = h.torrentFile()
            if (ti != null) break
            Thread.sleep(100)
        }
        if (ti == null) throw IllegalStateException("No peers answered with this torrent's metadata.")
        metadataMs = System.currentTimeMillis() - startedAt
        info = ti
        pieceLength = ti.pieceLength()

        // Swarm health gate: peers only. It used to test bytes-per-second here
        // and that test was worthless - it ran before any piece was
        // prioritized, so "moved" was 0 KB on every source ever measured and
        // the gate was really a 3-second rate sample. Measured on run 7: it
        // threw away sources with 4, 8 and 13 peers that were pulling
        // 90-125 KB/s at the 3s mark and would have grown. Peer count is the
        // one honest signal at this point; the byte-level check moved to
        // after warmHeadAndTail(), where something is actually downloading.
        val st0 = try { h.status() } catch (t: Throwable) { null }
        val peers0 = st0?.numPeers() ?: 0
        Log.i(TAG, "swarm peers=$peers0 rate=${st0?.downloadRate() ?: 0}")
        if (peers0 < 1) {
            // Metadata can come from a webseed or the DHT cache, so zero peers
            // here means nobody can serve the payload.
            val gateUntil = System.currentTimeMillis() + 3000
            var peersNow = peers0
            while (peersNow < 1 && System.currentTimeMillis() < gateUntil && !stopped.get()) {
                Thread.sleep(150)
                peersNow = try { h.status().numPeers() } catch (t: Throwable) { 0 }
            }
            if (peersNow < 1) throw IllegalStateException("swarm has no peers")
        }

        val storage = ti.files()
        val episodeIndex = if(wantedIndex == null && season >= 0 && episode > 0) {
            (0 until storage.numFiles()).firstOrNull { EpisodeFiles.matches(storage.filePath(it),season,episode) }
                ?: throw IllegalStateException("The selected episode is not in this torrent. Try another source.")
        } else wantedIndex
        val chosen = chooseFile(storage, episodeIndex)
        if (chosen < 0) throw IllegalStateException("This torrent has no playable video file.")
        resolvedVideoName = storage.fileName(chosen)
        fileIndex = chosen
        fileSize = storage.fileSize(chosen)
        fileOffset = storage.fileOffset(chosen)
        if (fileSize <= 0) throw IllegalStateException("This torrent's video file is empty.")

        // Control streaming solely with piece priorities. Updating file priorities here
        // completes asynchronously and would overwrite the requested streaming window.
        warmHeadAndTail()
        Log.i(TAG, "ready file=$chosen size=$fileSize offset=$fileOffset pieces=${ti.numPieces()} metadataMs=$metadataMs")
        // libtorrent only creates the payload once pieces start landing, so the
        // file may not exist yet. Wait for it instead of failing the first read.
        val path = awaitFile(15000)
        resolvedPath = path
        Log.i(TAG, "payload path=${path?.absolutePath ?: "MISSING"} after=${System.currentTimeMillis() - startedAt}ms")
        startDiagnostics()
    }

    private fun chooseFile(storage: org.libtorrent4j.FileStorage, wantedIndex: Int?): Int {
        val count = storage.numFiles()
        if (wantedIndex != null && wantedIndex >= 0 && wantedIndex < count && storage.fileSize(wantedIndex) > 0) {
            return wantedIndex
        }
        var best = -1
        var bestSize = 0L
        for (i in 0 until count) {
            val path = storage.filePath(i).lowercase()
            val size = storage.fileSize(i)
            if (size < 2L * 1024 * 1024) continue
            if (!path.endsWith(".mkv") && !path.endsWith(".mp4") && !path.endsWith(".avi") &&
                !path.endsWith(".m4v") && !path.endsWith(".webm") && !path.endsWith(".mov") &&
                !path.endsWith(".ts")
            ) continue
            if (size > bestSize) {
                bestSize = size
                best = i
            }
        }
        if (best >= 0) return best
        // No recognisable extension: fall back to the largest file.
        for (i in 0 until count) {
            if (storage.fileSize(i) > bestSize) {
                bestSize = storage.fileSize(i)
                best = i
            }
        }
        return best
    }

    private fun firstPiece(): Int = (fileOffset / pieceLength).toInt()
    private fun lastPiece(): Int = ((fileOffset + fileSize - 1) / pieceLength).toInt()

    private val deadlines = mutableSetOf<Int>()
    private var previousReadPiece = -1
    private fun warmHeadAndTail() {
        val h=handle ?: return
        val first=firstPiece()
        val headEnd=minOf(lastPiece(),first+2)
        h.prioritizePieces(Array(info!!.numPieces()) {Priority.IGNORE})
        for(piece in first..headEnd) {
            h.piecePriority(piece,Priority.TOP_PRIORITY)
            h.setPieceDeadline(piece,(piece-first)*250)
            deadlines.add(piece)
        }
        // MP4 may keep its moov index at the end. Matroska startup skips Cues.
        if(resolvedVideoName.endsWith(".mp4",true) || resolvedVideoName.endsWith(".m4v",true)) {
            h.piecePriority(lastPiece(),Priority.TOP_PRIORITY)
            h.setPieceDeadline(lastPiece(),2000)
            deadlines.add(lastPiece())
        }
        Log.i(TAG,"stream window first=$first headEnd=$headEnd; required pieces have deadlines")
    }

    /** Only verified pieces may reach the decoder or a TV. */
    @Synchronized
    fun readAt(position: Long, buffer: ByteArray, offset: Int, length: Int, waitMs: Long): Int {
        val h = handle ?: return -1
        if (position >= fileSize) return -1
        val absolute = fileOffset + position
        val firstNeeded = (absolute / pieceLength).toInt()
        val lastNeeded = ((absolute + length - 1) / pieceLength).toInt()
        val deadline = System.currentTimeMillis() + waitMs
        if(previousReadPiece>=0 && (firstNeeded<previousReadPiece || firstNeeded>previousReadPiece+8)) {
            h.clearPieceDeadlines();deadlines.clear()
        }
        // Schedule only the selected stream's current read and a small playback buffer.
        val entering=previousReadPiece!=firstNeeded
        for(piece in firstNeeded..minOf(lastPiece(),lastNeeded+2)) {
            if(!h.havePiece(piece) && (deadlines.add(piece) || entering)) {
                h.piecePriority(piece,Priority.TOP_PRIORITY)
                h.setPieceDeadline(piece,(piece-firstNeeded)*250)
            }
        }
        previousReadPiece=firstNeeded
        for (piece in firstNeeded..lastNeeded) {
            while (!h.havePiece(piece)) {
                if (stopped.get()) return -1
                if (System.currentTimeMillis() > deadline) {
                    val st = try { h.status() } catch (t: Throwable) { null }
                    val why = "piece $piece stalled after ${waitMs}ms" +
                        " (rate=${st?.downloadRate()} peers=${st?.numPeers()} path=${resolvedPath?.name ?: "none"})"
                    Log.w(TAG, why)
                    throw IOException(why)
                }
                Thread.sleep(40)
            }
        }
        val stream = ensureFile()
            ?: throw IOException("the download file is not on disk yet (${resolvedPath?.absolutePath ?: "unresolved"})")
        val want = minOf(length.toLong(), fileSize - position).toInt()
        val read = synchronized(stream) { stream.seek(position); stream.read(buffer, offset, want) }
        if (read > 0) {
            lastReadMs = System.currentTimeMillis()
            if (firstByteMs == 0L) {
                firstByteMs = lastReadMs - startMs
                Log.i(TAG, "first-bytes-to-player ms=$firstByteMs at position=$position")
            }
        }
        return read
    }

    private fun ensureFile(): RandomAccessFile? {
        raf?.let { return it }
        val f = resolvedPath ?: resolvePath() ?: return null
        resolvedPath = f
        return try {
            RandomAccessFile(f, "r").also { raf = it; file = f }
        } catch (t: Throwable) {
            null
        }
    }

    private fun resolvePath(): File? {
        val ti = info ?: return null
        val storage = ti.files()
        val name = ti.name()
        val saveDir = payloadDir ?: File(rootDir, "torrents")
        val rel = storage.filePath(fileIndex)
        val base = File(rel).name
        val candidates = ArrayList<File>()
        for (root in listOf(File(saveDir, name), saveDir, File(saveDir, name).parentFile ?: saveDir)) {
            val f = File(root, rel)
            candidates.add(f)
            candidates.add(File(f.parentFile, f.name + ".part"))
            candidates.add(File(f.parentFile, f.name + ".!qB"))
        }
        candidates.add(File(saveDir, base))
        candidates.add(File(File(saveDir, name), base))
        for (candidate in candidates) {
            if (candidate != null && candidate.isFile && candidate.length() > 0) return candidate
        }
        // Last resort: walk the save dir for a file with the same basename.
        val stack = ArrayDeque<File>()
        stack.add(saveDir)
        var guard = 0
        while (stack.isNotEmpty() && guard++ < 4000) {
            val dir = stack.removeFirst()
            val kids = dir.listFiles() ?: continue
            for (kid in kids) {
                if (kid.isDirectory) {
                    stack.add(kid)
                } else {
                    val n = kid.name
                    if (n == base || n == "$base.part" || n == "$base.!qB") {
                        if (kid.length() > 0) return kid
                    }
                }
            }
        }
        return null
    }

    /** Blocks until the payload file shows up on disk (or the deadline passes). */
    private fun awaitFile(timeoutMs: Long): File? {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline && !stopped.get()) {
            val f = resolvePath()
            if (f != null) return f
            Thread.sleep(200)
        }
        return null
    }

    /** Logs swarm health so a stall is visible in logcat instead of guessed at. */
    private fun startDiagnostics() {
        diagThread = Thread {
            val first = firstPiece()
            val last = lastPiece()
            while (!stopped.get()) {
                try {
                    val h = handle ?: break
                    val st = h.status()
                    val queued=h.getDownloadQueue().firstOrNull {it.pieceIndex()==first}
                    if(queued!=null)Log.i(TAG,"head-blocks finished=${queued.finished()} writing=${queued.writing()} requested=${queued.requested()} total=${queued.blocksInPiece()}")
                    // Which pieces are actually landing? "done=12582912
                    // haveFirst=false" said twelve pieces were complete while
                    // piece 0 was missing, even with sequential download set on
                    // the whole file. This bitmap answers it in one line instead
                    // of another guess.
                    val bits = StringBuilder()
                    for (p in first..minOf(last, first + 31)) {
                        bits.append(if (h.havePiece(p)) '1' else '0')
                    }
                    Log.i(
                        TAG,
                        "diag rate=${st.downloadRate()} peers=${st.numPeers()} done=${st.totalDone()}" +
                            " haveFirst=${h.havePiece(first)} haveLast=${h.havePiece(last)}" +
                            " firstByteMs=$firstByteMs freeMb=${(payloadDir?.usableSpace ?: 0L) / (1024 * 1024)} prio0=${try { h.piecePriority(first) } catch (t: Throwable) { "?" }} path=${resolvedPath?.name ?: "none"}"
                    )
                    Log.i(TAG, "pieces ${first}..${minOf(last, first + 31)} = $bits")
                    // Does the data for piece 0 exist on disk even though
                    // havePiece() says no? If these bytes look like a real file
                    // header (ftyp for MP4, 1A45DFA3 for MKV) then the engine is
                    // fine and the stall is in the player handoff. If they are
                    // zeros, the first piece really is missing.
                    try {
                        resolvedPath?.let { f ->
                            if (f.exists() && f.length() >= 16) {
                                java.io.RandomAccessFile(f, "r").use { raf ->
                                    val head = ByteArray(8)
                                    raf.seek(0)
                                    raf.readFully(head)
                                    Log.i(TAG, "disk head=${head.joinToString("") { b -> "%02x".format(b) }} fileLen=${f.length()}")
                                }
                            }
                        }
                    } catch (t: Throwable) {
                        Log.w(TAG, "disk head probe failed: ${t.javaClass.simpleName}: ${t.message}")
                    }
                } catch (t: Throwable) {
                }
                try {
                    Thread.sleep(2000)
                } catch (t: Throwable) {
                    break
                }
            }
        }.apply { isDaemon = true; name = "torrent-diag"; start() }
    }

    fun status(): JSONObject {
        val h = handle ?: return JSONObject()
        val out = JSONObject()
        return try {
            val st = h.status()
            out.put("progress", st.progress())
            out.put("downloadRate", st.downloadRate())
            out.put("numPeers", st.numPeers())
            out.put("totalDone", st.totalDone())
            out.put("metadataMs", metadataMs)
            out.put("fileIndex", fileIndex)
            out.put("fileSize", fileSize)
            out
        } catch (t: Throwable) {
            out
        }
    }

    fun subtitleHash(): JSONObject? {
        val size=fileSize
        if(size<131072)return null
        val blocks=listOf(0L,size-65536)
        var hash=size
        for(position in blocks) {
            val bytes=ByteArray(65536)
            var filled=0
            while(filled<bytes.size) {
                val count=readAt(position+filled,bytes,filled,bytes.size-filled,1500)
                if(count<=0)return null
                filled+=count
            }
            val buffer=java.nio.ByteBuffer.wrap(bytes).order(java.nio.ByteOrder.LITTLE_ENDIAN)
            while(buffer.remaining()>=8)hash+=buffer.long
        }
        return JSONObject().put("hash",java.lang.Long.toUnsignedString(hash,16).padStart(16,'0')).put("size",size)
    }

    fun stop() {
        stopped.set(true)
        diagThread?.interrupt()
        try {
            raf?.close()
        } catch (t: Throwable) {
        }
        raf = null
        try {
            session?.stop()
        } catch (t: Throwable) {
        }
        session = null
        handle = null
    }

    /**
     * Stops the swarm, then deletes everything it wrote. Order matters: deleting
     * while a session is live leaves libtorrent writing into files that no longer
     * exist. Sam's rule for this cache: it may hold a little while a movie plays,
     * it must not stack up, and it goes when the player closes.
     */
    fun purge() {
        stop()
        // Only this attempt's own folder. The renderer opens a fresh player for
        // every source it tries, and the previous player's cleanup must never
        // delete the folder a live attempt is already writing into.
        val dir = payloadDir ?: return
        val freed = try { sizeOf(dir) } catch (t: Throwable) { 0L }
        try {
            dir.deleteRecursively()
            Log.i(TAG, "cache purged: ${freed / (1024 * 1024)} MB freed, dir=${dir.name} exists=${dir.exists()}")
        } catch (t: Throwable) {
            Log.w(TAG, "cache purge failed: ${t.message}")
        }
    }

    private fun sizeOf(dir: File): Long {
        var total = 0L
        dir.walkTopDown().forEach { if (it.isFile) total += it.length() }
        return total
    }
}
