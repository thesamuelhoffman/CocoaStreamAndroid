package app.cocoastream.android

import java.net.ServerSocket
import java.net.Socket
import java.net.NetworkInterface
import java.net.Inet4Address
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.TimeUnit

/** A short-lived, unguessable LAN URL for TV range requests. Closed with the player. */
class CastStream(private val engine:TorrentEngine) {
    private val server=ServerSocket(0)
    private val token=UUID.randomUUID().toString()
    private val clients=java.util.concurrent.ConcurrentHashMap.newKeySet<Socket>()
    private val workers=ThreadPoolExecutor(2,4,30,TimeUnit.SECONDS,ArrayBlockingQueue<Runnable>(8))
    init { Thread({while(!server.isClosed) {try {
        val socket=server.accept();socket.soTimeout=5000
        if(!socket.inetAddress.isSiteLocalAddress && !socket.inetAddress.isLinkLocalAddress){socket.close();continue}
        clients.add(socket)
        try {workers.execute{socket.use{try{serve(it)}catch(_:Exception){}finally{clients.remove(it)}}}}catch(_:Exception){clients.remove(socket);socket.close()}
    }catch(_:Exception){}}},"cocoa-tv-stream").start() }
    fun url():String {
        val addresses=NetworkInterface.getNetworkInterfaces().toList().flatMap {it.inetAddresses.toList()}
        val address=addresses.firstOrNull{it is Inet4Address && it.isSiteLocalAddress && !it.isLoopbackAddress}
            ?: throw IllegalStateException("Join the same Wi-Fi network as your TV.")
        return "http://${address.hostAddress}:${server.localPort}/$token/video"
    }
    private fun serve(socket:Socket) {
        val reader=socket.getInputStream().bufferedReader()
        val line=reader.readLine() ?: return
        if(line.length>8192)return
        val request=line.split(' ')
        val out=socket.getOutputStream()
        if(request.size<2 || request[1]!="/$token/video" || request[0] !in listOf("GET","HEAD")) {
            out.write("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".toByteArray());return
        }
        var range=""
        for (i in 0 until 64) {
            val header=reader.readLine() ?: break
            if(header.isEmpty())break
            if(header.length>8192)return
            if(header.startsWith("Range:",true))range=header.substringAfter(':').trim()
        }
        val size=engine.fileSize
        var first=0L;var last=size-1
        if(range.isNotBlank()) {
            val m=Regex("bytes=(\\d*)-(\\d*)").matchEntire(range)
            if(m==null){out.write("HTTP/1.1 416 Range Not Satisfiable\r\nContent-Length: 0\r\n\r\n".toByteArray());return}
            val a=m.groupValues[1].toLongOrNull();val b=m.groupValues[2].toLongOrNull()
            if(a==null && b!=null)first=(size-b).coerceAtLeast(0) else {first=a ?: 0;last=(b ?: last).coerceAtMost(size-1)}
        }
        if(first<0 || first>=size || last<first){out.write("HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */$size\r\nContent-Length: 0\r\n\r\n".toByteArray());return}
        val partial=range.isNotBlank()
        val mime=if(engine.resolvedPath?.extension.equals("mkv",true)) "video/x-matroska" else "video/mp4"
        out.write(("HTTP/1.1 ${if(partial) "206 Partial Content" else "200 OK"}\r\nContent-Type: $mime\r\nAccept-Ranges: bytes\r\nContent-Length: ${last-first+1}\r\n"+
            (if(partial) "Content-Range: bytes $first-$last/$size\r\n" else "")+"Connection: close\r\n\r\n").toByteArray())
        if(request[0]=="HEAD")return
        var position=first;val buffer=ByteArray(65536)
        while(position<=last && !server.isClosed) {
            val count=engine.readAt(position,buffer,0,minOf(buffer.size.toLong(),last-position+1).toInt(),15000)
            if(count<=0)break
            out.write(buffer,0,count);position+=count
        }
        out.flush()
    }
    fun close(){server.close();clients.forEach{try{it.close()}catch(_:Exception){}};workers.shutdownNow()}
}
