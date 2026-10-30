package app.cocoastream.android

import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors

/** Holds at most one next-episode torrent warm-up, and hands it to the player on demand. */
object TorrentPrewarm {
    private data class Key(val root:String,val hash:String,val file:Int,val season:Int,val episode:Int)
    private val lock=Object()
    private val worker=Executors.newSingleThreadExecutor()
    private var generation=0L
    private var readyKey:Key?=null
    private var readyEngine:TorrentEngine?=null
    private var readyAt=0L
    private var warmingKey:Key?=null
    private var warmingEngine:TorrentEngine?=null

    fun prepare(root:File,payload:JSONObject):JSONObject {
        val stream=payload.optJSONObject("stream") ?: return JSONObject().put("accepted",false)
        val hash=stream.optString("infoHash").trim().lowercase()
        if(hash.isEmpty())return JSONObject().put("accepted",false)
        val file=stream.optInt("fileIdx",-1)
        val season=payload.optInt("season",-1)
        val episode=payload.optInt("episode",-1)
        val key=Key(root.absolutePath,hash,file,season,episode)
        val token:Long
        val oldReady:TorrentEngine?
        val oldWarm:TorrentEngine?
        synchronized(lock) {
            if(readyKey==key || warmingKey==key)return JSONObject().put("accepted",true).put("alreadyWarming",true)
            generation++
            token=generation
            oldReady=readyEngine
            oldWarm=warmingEngine
            readyEngine=null;readyKey=null;readyAt=0L
            warmingEngine=null;warmingKey=key
        }
        oldReady?.let{Thread({it.purge()},"cocoa-prewarm-replace").start()}
        oldWarm?.stop()
        worker.execute {
            val engine=TorrentEngine(root)
            val current=synchronized(lock) {
                if(generation==token) {warmingKey=key;warmingEngine=engine;true} else false
            }
            if(!current) {engine.purge();return@execute}
            try {
                val wanted=file.takeIf{it>=0}
                engine.start(engine.magnetFor(hash,stream),wanted,timeoutMs=45000,season=season,episode=episode)
                val accepted=synchronized(lock) {
                    if(generation==token && warmingEngine===engine) {
                        readyKey=key;readyEngine=engine;readyAt=System.currentTimeMillis()
                        warmingKey=null;warmingEngine=null;lock.notifyAll();true
                    } else false
                }
                if(!accepted)engine.purge()
            } catch (_:Throwable) {
                synchronized(lock) {
                    if(generation==token && warmingEngine===engine) {warmingKey=null;warmingEngine=null;lock.notifyAll()}
                }
                engine.purge()
            }
        }
        return JSONObject().put("accepted",true)
    }

    /** Called from the player's IO thread; briefly waits if the last pieces are settling. */
    fun take(root:File,hash:String,fileIndex:Int?,season:Int,episode:Int):TorrentEngine? {
        val key=Key(root.absolutePath,hash.trim().lowercase(),fileIndex ?: -1,season,episode)
        var discardReady:TorrentEngine?=null
        var discardWarm:TorrentEngine?=null
        val result:TorrentEngine?
        synchronized(lock) {
            val deadline=System.currentTimeMillis()+5000L
            while(warmingKey==key && readyEngine==null && System.currentTimeMillis()<deadline) {
                try {lock.wait(minOf(250L,deadline-System.currentTimeMillis()))} catch (_:InterruptedException) {Thread.currentThread().interrupt();break}
            }
            if(readyKey==key && readyEngine!=null && System.currentTimeMillis()-readyAt<20*60*1000L) {
                result=readyEngine
                readyEngine=null;readyKey=null;readyAt=0L
            } else {
                result=null
                if(readyEngine!=null && System.currentTimeMillis()-readyAt>=20*60*1000L) {
                    discardReady=readyEngine;readyEngine=null;readyKey=null;readyAt=0L
                }
                if(warmingKey==key) {
                    generation++;discardWarm=warmingEngine;warmingEngine=null;warmingKey=null;lock.notifyAll()
                }
            }
        }
        discardReady?.let{Thread({it.purge()},"cocoa-prewarm-discard").start()}
        discardWarm?.stop()
        return result
    }
}
