package app.cocoastream.android

import android.app.Activity
import android.content.pm.ActivityInfo
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.Typeface
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.SeekBar
import android.widget.TextView
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.Tracks
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.hls.HlsMediaSource
import androidx.media3.exoplayer.source.ProgressiveMediaSource
import androidx.media3.extractor.DefaultExtractorsFactory
import androidx.media3.extractor.mkv.MatroskaExtractor
import androidx.media3.ui.CaptionStyleCompat
import androidx.media3.ui.PlayerView
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors

/**
 * Full-screen playback. Media3/ExoPlayer does the decoding (hardware first),
 * the torrent is read through TorrentDataSource, and subtitles are styled with
 * CocoaStream's own font.
 */
class PlayerActivity : Activity() {
    companion object {
        private const val TAG = "CocoaStreamPlayback"
        @Volatile var current: PlayerActivity? = null
    }

    private data class Subtitle(val uri: Uri, val mimeType: String, val label: String, val language: String)

    private lateinit var payload: JSONObject
    private var ownerId: String = ""
    private var player: ExoPlayer? = null
    private var playerView: PlayerView? = null
    private var statusText: TextView? = null
    private var episodeButton: android.view.View? = null
    private var seekBar: SeekBar? = null
    private var timeLabel: TextView? = null
    private var playButton: TextView? = null
    private var sourcePickerPending = false
    private var sourceLoadingDialog: android.app.AlertDialog? = null
    private var scrubbing = false
    private var loadGeneration = 0
    private var engine: TorrentEngine? = null
    private var castStream: CastStream? = null
    private var controlsState = JSONObject()
    private var currentUri: Uri? = null
    private var subs = ArrayList<Subtitle>()
    private val subtitleUrls = mutableSetOf<String>()
    private var startedAt = 0L
    private var firstFrame = false
    private var finished = false
    @Volatile private var latestStats = JSONObject()
    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()

    // A Matroska file keeps its index (Cues) at the very end, so the demuxer
    // seeks there before it paints and that tail read is the slowest thing a
    // torrent can serve. Measured on the build28 cold run: Obsession opened the
    // tail 6.7 MB from the end 12 s in, gave up, then hung 48 s on a 75 KB tail
    // read and never painted. Playback from the start does not need the index,
    // so the extractor is told to skip it; the duration still comes from the
    // header at the front of the file.
    private val extractorsFactory = DefaultExtractorsFactory()
        .setMatroskaExtractorFlags(MatroskaExtractor.FLAG_DISABLE_SEEK_FOR_CUES)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // One player at a time. The renderer starts a fresh PlayerActivity for
        // every source it tries, and an activity that is merely covered keeps
        // its torrent session alive. Measured on the emulator: four live
        // swarms inside one movie, all fighting for a single core and the
        // same bandwidth, and the last attempt got no bytes at all.
        current?.let { prev -> if (prev !== this) prev.abandon() }
        current = this
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        payload = try {
            JSONObject(intent.getStringExtra("payload") ?: "{}")
        } catch (t: Throwable) {
            JSONObject()
        }
        ownerId = payload.optString("ownerId")
        startedAt = System.currentTimeMillis()

        val root = FrameLayout(this)
        root.setBackgroundColor(Color.BLACK)
        val pv = PlayerView(this).apply {
            useController = false
            setShowBuffering(PlayerView.SHOW_BUFFERING_WHEN_PLAYING)
            setBackgroundColor(Color.BLACK)
            layoutParams = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        }
        root.addView(pv)
        val status = TextView(this).apply {
            text = "Opening source…"
            setTextColor(Color.parseColor("#e8e8ef"))
            textSize = 15f
            gravity = Gravity.CENTER
            layoutParams = FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                gravity = Gravity.CENTER
            }
        }
        root.addView(status)
        val top = android.widget.LinearLayout(this).apply {
            orientation=android.widget.LinearLayout.HORIZONTAL
            setPadding(dp(12),dp(12),dp(12),dp(12))
            layoutParams=FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,ViewGroup.LayoutParams.WRAP_CONTENT,Gravity.TOP)
        }
        fun button(label:String, click:()->Unit) {
            top.addView(TextView(this).apply {
                text=label; textSize=13f; setTextColor(Color.WHITE); gravity=Gravity.CENTER
                setPadding(dp(13),0,dp(13),0)
                background=android.graphics.drawable.GradientDrawable().apply {
                    setColor(Color.argb(205,20,27,22)); cornerRadius=dp(22).toFloat()
                    setStroke(dp(1),Color.argb(105,210,235,215))
                }
                layoutParams=android.widget.LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT,dp(44)).apply { marginEnd=dp(8) }
                setOnClickListener{click()}
            })
        }
        button("‹  Back"){finishPlayback(false)}
        button("Sources"){showSources()}
        button("Episodes"){showEpisodes()}
        episodeButton=top.getChildAt(top.childCount-1)
        episodeButton?.visibility=android.view.View.GONE
        button("Playback"){showMore()}
        SubtitleFont.peek(this)?.let { face -> for(i in 0 until top.childCount) (top.getChildAt(i) as? TextView)?.typeface=face }
        root.addView(top)
        val bottom = LinearLayout(this).apply {
            orientation=LinearLayout.VERTICAL
            setPadding(dp(16),dp(12),dp(16),dp(14))
            background=android.graphics.drawable.GradientDrawable(
                android.graphics.drawable.GradientDrawable.Orientation.TOP_BOTTOM,
                intArrayOf(Color.TRANSPARENT,Color.argb(225,0,0,0))
            )
            layoutParams=FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,ViewGroup.LayoutParams.WRAP_CONTENT,Gravity.BOTTOM)
        }
        val seekRow=LinearLayout(this).apply { orientation=LinearLayout.HORIZONTAL; gravity=Gravity.CENTER_VERTICAL }
        val time=TextView(this).apply { text="0:00 / --:--";setTextColor(Color.WHITE);textSize=12f;setPadding(0,0,dp(10),0) }
        val seek=SeekBar(this).apply {
            max=1000
            isEnabled=false
            progressTintList=android.content.res.ColorStateList.valueOf(Color.rgb(100,190,118))
            thumbTintList=android.content.res.ColorStateList.valueOf(Color.WHITE)
            layoutParams=LinearLayout.LayoutParams(0,dp(38),1f)
            setOnSeekBarChangeListener(object:SeekBar.OnSeekBarChangeListener {
                override fun onProgressChanged(bar:SeekBar,value:Int,fromUser:Boolean) {
                    if(fromUser) updateTimeLabel(player?.currentPosition ?: 0L,player?.duration ?: 0L,value)
                }
                override fun onStartTrackingTouch(bar:SeekBar) { scrubbing=true }
                override fun onStopTrackingTouch(bar:SeekBar) {
                    scrubbing=false
                    val duration=player?.duration ?: 0L
                    if(duration>0) player?.seekTo((duration*bar.progress/1000L).coerceIn(0L,duration))
                }
            })
        }
        timeLabel=time;seekBar=seek
        seekRow.addView(time);seekRow.addView(seek)
        bottom.addView(seekRow)
        val actions=LinearLayout(this).apply { orientation=LinearLayout.HORIZONTAL;gravity=Gravity.CENTER;setPadding(0,dp(4),0,0) }
        fun control(label:String, description:String=label, click:()->Unit):TextView {
            val view=TextView(this).apply {
                text=label;contentDescription=description;setTextColor(Color.WHITE);textSize=16f;gravity=Gravity.CENTER
                setPadding(dp(14),0,dp(14),0);minWidth=dp(54);minHeight=dp(44)
                background=android.graphics.drawable.GradientDrawable().apply {setColor(Color.argb(135,20,27,22));cornerRadius=dp(14).toFloat()}
                layoutParams=LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT,dp(44)).apply {marginStart=dp(5);marginEnd=dp(5)}
                setOnClickListener{click()}
            }
            actions.addView(view);return view
        }
        control("−10","Back 10 seconds"){seekBy(-10_000)}
        playButton=control("▶","Play"){if(player?.isPlaying==true)player?.pause() else player?.play()}
        control("+10","Forward 10 seconds"){seekBy(10_000)}
        control("↻","Rotate screen"){rotateScreen()}
        bottom.addView(actions)
        root.addView(bottom)
        setContentView(root)
        applyImmersiveFullscreen()
        playerView = pv
        statusText = status
        applySubtitleStyle(pv)
        SubtitleFont.load(this) { face -> if(face!=null) for(i in 0 until top.childCount) (top.getChildAt(i) as? TextView)?.typeface=face }

        val loadControl=DefaultLoadControl.Builder()
            .setBufferDurationsMs(20_000,20_000,1_000,2_000)
            .setBackBuffer(5_000,true)
            .setPrioritizeTimeOverSizeThresholds(true)
            .build()
        val exo = ExoPlayer.Builder(this).setLoadControl(loadControl).build()
        player = exo
        pv.player = exo
        exo.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(state: Int) {
                Log.i(TAG,"state=$state owner=$ownerId firstFrame=$firstFrame")
                if (state == Player.STATE_READY) statusText?.visibility = TextView.GONE
                if (state == Player.STATE_ENDED) finishPlayback(true)
            }

            override fun onRenderedFirstFrame() {
                if (firstFrame) return
                firstFrame = true
                val ms = System.currentTimeMillis() - startedAt
                Log.i(TAG, "first-frame ownerId=$ownerId ms=$ms")
                statusText?.visibility = TextView.GONE
                PlaybackBus.listener?.onReady(ownerId, ms)
                updatePlaybackControls(exo)
            }

            override fun onIsPlayingChanged(isPlaying:Boolean) { updatePlaybackControls(exo) }

            override fun onPlayerError(error: PlaybackException) {
                Log.w(TAG, "player error: ${error.errorCodeName} ${error.message}")
                fail(error.message ?: "The player could not open this source.")
            }
        })
        main.post(statsTicker)
        scheduleLoadTimeout()
        open()
    }

    private fun applySubtitleStyle(pv: PlayerView) {
        applySubtitleStyle(pv, SubtitleFont.peek(this))
        // The pixel font is downloaded once, off the main thread (a network
        // call here threw NetworkOnMainThreadException), then the subtitle view
        // is restyled when it lands.
        if (SubtitleFont.peek(this) == null) {
            SubtitleFont.load(this) { face ->
                if (face != null && !finished) applySubtitleStyle(pv, face)
            }
        }
    }

    private fun applySubtitleStyle(pv: PlayerView, typeface: Typeface?) {
        val style = CaptionStyleCompat(
            Color.WHITE,
            Color.TRANSPARENT,
            Color.TRANSPARENT,
            CaptionStyleCompat.EDGE_TYPE_OUTLINE,
            Color.BLACK,
            typeface
        )
        pv.subtitleView?.let { view ->
            view.setStyle(style)
            view.setApplyEmbeddedStyles(false)
            view.setApplyEmbeddedFontSizes(false)
            view.setFixedTextSize(TypedValue.COMPLEX_UNIT_SP, 20f)
            view.setBottomPaddingFraction(0.07f)
        }
    }

    private fun open() {
        val stream = payload.optJSONObject("stream") ?: JSONObject()
        val infoHash = stream.optString("infoHash")
        val url = stream.optString("url")
        val resume = payload.optLong("resumePosition", 0L)
        val fileIdx = if (stream.has("fileIdx") && !stream.isNull("fileIdx")) stream.optInt("fileIdx") else null
        // One line that proves where playback starts: 0 on a fresh play, a real
        // position when the app resumed something watched earlier.
        Log.i(TAG, "open resume=$resume infoHash=${infoHash.take(8)} url=${if (url.isEmpty()) "none" else url.take(60)} fileIdx=$fileIdx")
        if (infoHash.isNotEmpty()) {
            openTorrent(infoHash, fileIdx, stream, resume)
        } else if (url.isNotEmpty()) {
            startMedia(Uri.parse(url), resume)
        } else {
            fail("This add-on returned a source CocoaStream cannot open.")
        }
    }

    private fun openTorrent(infoHash: String, fileIdx: Int?, stream: JSONObject, resume: Long) {
        statusText?.text = "Finding peers…"
        PlaybackBus.listener?.onStage(ownerId, "metadata")
        io.execute {
            try {
                val root=File(cacheDir,"cocoa")
                val season=payload.optInt("season",-1)
                val episode=payload.optInt("episode",-1)
                val warmed=TorrentPrewarm.take(root,infoHash,fileIdx,season,episode)
                val eng=warmed ?: TorrentEngine(root)
                engine = eng
                if(warmed==null)eng.start(eng.magnetFor(infoHash,stream),fileIdx,season=season,episode=episode)
                Log.i(TAG, "torrent ready metadataMs=${eng.metadataMs} size=${eng.fileSize}")
                PlaybackBus.listener?.onStage(ownerId,"ready")
                runOnUiThread {
                    statusText?.text = "Buffering…"
                    startMedia(Uri.parse("cocoa://stream/$infoHash"), resume)
                }
            } catch (t: Throwable) {
                Log.w(TAG, "torrent failed: ${t.message}")
                fail(t.message ?: "The torrent did not start.")
            }
        }
    }

    private fun dataSourceFactory(): DataSource.Factory {
        val eng = engine ?: run {
            val headers=mutableMapOf<String,String>()
            val stream=payload.optJSONObject("stream")
            val requested=stream?.optJSONObject("behaviorHints")?.optJSONObject("proxyHeaders")?.optJSONObject("request") ?: stream?.optJSONObject("headers")
            requested?.keys()?.forEach { key -> headers[key]=requested.optString(key) }
            val http=androidx.media3.datasource.DefaultHttpDataSource.Factory().setUserAgent("CocoaStreamAndroid/1.1")
                .setAllowCrossProtocolRedirects(false).setDefaultRequestProperties(headers)
            return DefaultDataSource.Factory(this,http)
        }
        return DefaultDataSource.Factory(this, TorrentDataSource.Factory(eng))
    }

    private fun startMedia(uri: Uri, positionMs: Long) {
        val exo = player ?: return
        Log.i(TAG,"start-media scheme=${uri.scheme} positionMs=$positionMs engine=${engine!=null}")
        currentUri = uri
        val itemBuilder = MediaItem.Builder().setUri(uri)
        if (subs.isNotEmpty()) {
            itemBuilder.setSubtitleConfigurations(subs.map { sub ->
                MediaItem.SubtitleConfiguration.Builder(sub.uri)
                    .setMimeType(sub.mimeType)
                    .setLanguage(sub.language)
                    .setSelectionFlags(if(sub == subs.lastOrNull()) C.SELECTION_FLAG_DEFAULT else 0)
                    .setLabel(sub.label)
                    .build()
            })
        }
        val item = itemBuilder.build()
        val factory = dataSourceFactory()
        val source = if (uri.toString().contains(".m3u8", ignoreCase = true)) {
            HlsMediaSource.Factory(factory).createMediaSource(item)
        } else {
            ProgressiveMediaSource.Factory(factory, extractorsFactory).createMediaSource(item)
        }
        exo.setMediaSource(source, positionMs)
        exo.prepare()
        exo.playWhenReady = true
    }

    private fun scheduleLoadTimeout() {
        val attempt=++loadGeneration
        main.postDelayed({
            if(attempt==loadGeneration && !finished && !firstFrame) fail("This source did not deliver a picture within 35 seconds. Try another source.")
        },35000)
    }

    private fun updatePlaybackControls(exo:ExoPlayer) {
        val duration=exo.duration
        val position=exo.currentPosition.coerceAtLeast(0L)
        val bar=seekBar
        val hasTimeline=duration>0L && duration!=C.TIME_UNSET
        bar?.isEnabled=hasTimeline
        if(hasTimeline && !scrubbing) bar?.progress=((position*1000L/duration).toInt()).coerceIn(0,1000)
        updateTimeLabel(position,duration,if(scrubbing)bar?.progress else null)
        playButton?.apply { text=if(exo.isPlaying)"Ⅱ" else "▶";contentDescription=if(exo.isPlaying)"Pause" else "Play" }
    }

    private fun updateTimeLabel(position:Long,duration:Long,progress:Int?) {
        val total=duration.takeIf{it>0L && it!=C.TIME_UNSET}
        val shown=if(progress!=null && total!=null) total*progress/1000L else position
        timeLabel?.text="${formatTime(shown)} / ${total?.let(::formatTime) ?: "--:--"}"
    }

    private fun formatTime(ms:Long):String {
        val total=(ms.coerceAtLeast(0L)/1000L)
        val seconds=total%60
        val minutes=total/60
        return if(minutes>=60) String.format(java.util.Locale.ROOT,"%d:%02d:%02d",minutes/60,minutes%60,seconds)
        else String.format(java.util.Locale.ROOT,"%d:%02d",minutes,seconds)
    }

    private fun seekBy(deltaMs:Long) {
        val exo=player ?: return
        val duration=exo.duration.takeIf{it>0L && it!=C.TIME_UNSET}
        val target=(exo.currentPosition+deltaMs).coerceAtLeast(0L).let{if(duration!=null)it.coerceAtMost(duration)else it}
        exo.seekTo(target)
        updatePlaybackControls(exo)
    }

    private fun rotateScreen() {
        requestedOrientation=if(resources.configuration.orientation==Configuration.ORIENTATION_LANDSCAPE)
            ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT else ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
        applyImmersiveFullscreen()
    }

    @Suppress("DEPRECATION")
    private fun applyImmersiveFullscreen() {
        window.decorView.systemUiVisibility=(android.view.View.SYSTEM_UI_FLAG_FULLSCREEN
            or android.view.View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
            or android.view.View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
            or android.view.View.SYSTEM_UI_FLAG_LAYOUT_STABLE
            or android.view.View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
            or android.view.View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION)
    }

    override fun onWindowFocusChanged(hasFocus:Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if(hasFocus) applyImmersiveFullscreen()
    }

    private fun showSources() {
        if(sourcePickerPending)return
        sourcePickerPending=true
        sourceLoadingDialog=android.app.AlertDialog.Builder(this)
            .setTitle("Sources")
            .setMessage("Finding available sources…")
            .setNegativeButton("Cancel"){_,_->sourcePickerPending=false;sourceLoadingDialog=null}
            .create().also { it.setOnCancelListener{sourcePickerPending=false;sourceLoadingDialog=null};it.show() }
        action("request-sources")
    }

    private fun showSourceResults() {
        if(!sourcePickerPending)return
        sourcePickerPending=false
        sourceLoadingDialog?.dismiss();sourceLoadingDialog=null
        val sources=controlsState.optJSONArray("sources") ?: org.json.JSONArray()
        val error=controlsState.optString("sourcesError")
        if(sources.length()==0) {
            showChoiceSheet("Sources",arrayOf(error.ifBlank{"No usable sources found."})){}
            return
        }
        val labels=Array(sources.length()){i ->
            val source=sources.optJSONObject(i)
            val parts=listOfNotNull(source?.optString("label")?.takeIf{!it.isNullOrBlank()},source?.optString("quality")?.takeIf{!it.isNullOrBlank()},source?.optString("size")?.takeIf{!it.isNullOrBlank()})
            (if(i==controlsState.optInt("sourceIndex",-1))"✓  " else "")+(parts.joinToString("  ·  ").ifBlank{"Source ${i+1}"})
        }
        showChoiceSheet("Choose a source",labels){index->action("select-source","index",index.toString())}
    }

    private val statsTicker = object : Runnable {
        override fun run() {
            val exo = player
            if (exo != null && !finished) {
                latestStats = buildStats(exo)
                PlaybackBus.listener?.onStats(ownerId, latestStats)
                updatePlaybackControls(exo)
            }
            main.postDelayed(this, 500)
        }
    }

    private fun buildStats(exo: ExoPlayer): JSONObject {
        val out = JSONObject()
        return try {
            out.put("ownerId", ownerId)
            out.put("position", exo.currentPosition.toDouble())
            out.put("duration", exo.duration.toDouble())
            out.put("paused", !exo.isPlaying)
            out.put("buffered", exo.bufferedPosition.toDouble())
            out.put("subtitleId", selectedSubtitleId(exo))
            val tracks = org.json.JSONArray()
            textGroups(exo).forEachIndexed { groupIndex, group ->
                for (i in 0 until group.length) {
                    val format = group.getTrackFormat(i)
                    tracks.put(
                        JSONObject()
                            .put("id", groupIndex * 100 + i)
                            .put("label", format.label ?: format.language ?: "Track ${groupIndex + 1}")
                            .put("lang", format.language ?: "")
                            .put("external", format.id?.contains("subtitle") ?: false)
                    )
                }
            }
            out.put("subtitleTracks", tracks)
            engine?.status()?.let { torrent ->
                out.put("torrent", torrent)
            }
            out
        } catch (t: Throwable) {
            out
        }
    }

    private fun textGroups(exo: ExoPlayer): List<Tracks.Group> =
        exo.currentTracks.groups.filter { it.type == C.TRACK_TYPE_TEXT }

    private fun selectedSubtitleId(exo: ExoPlayer): Int {
        val groups = textGroups(exo)
        groups.forEachIndexed { groupIndex, group ->
            for (i in 0 until group.length) {
                if (group.isTrackSelected(i)) return groupIndex * 100 + i
            }
        }
        return -1
    }

    fun owns(owner:String) = ownerId == owner

    fun statsSnapshot(): JSONObject = latestStats

    fun subtitleHash():JSONObject? = try {engine?.subtitleHash()}catch(_:Exception){null}

    fun torrentStats(): JSONObject = engine?.status() ?: JSONObject()

    fun selectSubtitle(id: Int): JSONObject {
        runOnUiThread {
            val exo = player ?: return@runOnUiThread
            val params = exo.trackSelectionParameters.buildUpon()
            if (id < 0) {
                exo.trackSelectionParameters = params.setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true).build()
            } else {
                val groups = textGroups(exo)
                val groupIndex = id / 100
                val trackIndex = id % 100
                val group = groups.getOrNull(groupIndex)
                if (group != null && trackIndex < group.length) {
                    exo.trackSelectionParameters = params
                        .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false)
                        .clearOverridesOfType(C.TRACK_TYPE_TEXT)
                        .setOverrideForType(TrackSelectionOverride(group.mediaTrackGroup, trackIndex))
                        .build()
                }
            }
        }
        return JSONObject().put("ok", true)
    }

    fun addSubtitle(payload: JSONObject): JSONObject {
        val url = payload.optString("url")
        if (url.isEmpty()) return JSONObject().put("ok", false)
        if (url in subtitleUrls) return JSONObject().put("ok",true)
        val label = payload.optString("title").ifEmpty { "Subtitle" }
        val language = payload.optString("lang").ifEmpty { "en" }
        return try {
            val text = Addons().fetchText(url, payload.optJSONObject("headers"))
            val (mime, ext) = detectSubtitle(text, url)
            val dir = File(cacheDir, "subs").apply { mkdirs() }
            val file = File(dir, "sub-${System.currentTimeMillis()}.$ext")
            file.writeText(text)
            subs.add(Subtitle(Uri.fromFile(file), mime, label, language))
            subtitleUrls.add(url)
            Log.i(TAG, "subtitle added $label ($mime)")
            runOnUiThread {
                val position = player?.currentPosition ?: 0L
                val wasPlaying = player?.playWhenReady ?: false
                currentUri?.let { startMedia(it, position) }
                player?.playWhenReady = wasPlaying
            }
            JSONObject().put("ok", true).put("label", label)
        } catch (t: Throwable) {
            Log.w(TAG, "subtitle failed: ${t.message}")
            JSONObject().put("ok", false).put("message", t.message ?: "Subtitle failed")
        }
    }

    private fun detectSubtitle(text: String, url: String): Pair<String, String> {
        val head = text.take(2048)
        return when {
            head.trimStart().startsWith("WEBVTT") -> MimeTypes.TEXT_VTT to "vtt"
            head.contains("[Script Info]") || head.contains("Dialogue:") -> MimeTypes.TEXT_SSA to "ass"
            url.contains(".ass", true) -> MimeTypes.TEXT_SSA to "ass"
            url.contains(".vtt", true) -> MimeTypes.TEXT_VTT to "vtt"
            else -> MimeTypes.APPLICATION_SUBRIP to "srt"
        }
    }

    fun command(command: org.json.JSONArray?, ownerId: String): JSONObject {
        val exo = player ?: return JSONObject().put("ok", false)
        if (ownerId.isNotBlank() && ownerId != this.ownerId) return JSONObject().put("ok",false)
        if (command == null || command.length() == 0) return JSONObject().put("ok", true)
        runOnUiThread {
            when (command.optString(0)) {
                "cycle" -> when (command.optString(1)) {
                    "pause" -> if (exo.isPlaying) exo.pause() else exo.play()
                    "mute" -> exo.volume = if (exo.volume > 0f) 0f else 1f
                }
                "seek" -> {
                    val amount = command.optDouble(1, 0.0)
                    val mode = command.optString(2)
                    val target = if (mode.contains("relative")) exo.currentPosition + (amount * 1000).toLong() else (amount * 1000).toLong()
                    exo.seekTo(maxOf(0L, target))
                }
                "set_property" -> when(command.optString(1)) {
                    "pause" -> exo.playWhenReady = !command.optBoolean(2)
                    "speed" -> exo.setPlaybackSpeed(command.optDouble(2,1.0).coerceIn(0.25,3.0).toFloat())
                    "volume" -> exo.volume=(command.optDouble(2,100.0)/100).coerceIn(0.0,1.0).toFloat()
                }
                "add" -> if (command.optString(1) == "volume") {
                    val delta = command.optDouble(2, 0.0) / 100.0
                    exo.volume = (exo.volume + delta).coerceIn(0.0, 1.0).toFloat()
                }
            }
        }
        return JSONObject().put("ok", true)
    }

    fun replaceSource(next:JSONObject):JSONObject {
        if(next.optString("ownerId")!=ownerId || finished)return JSONObject().put("ok",false)
        runOnUiThread {
            if(finished)return@runOnUiThread
            val oldEngine=engine
            engine=null
            player?.stop()
            player?.clearMediaItems()
            currentUri=null
            subs.clear();subtitleUrls.clear()
            payload=next
            firstFrame=false
            startedAt=System.currentTimeMillis()
            latestStats=JSONObject()
            statusText?.text="Opening source…"
            statusText?.visibility=android.view.View.VISIBLE
            oldEngine?.let{old->Thread({old.purge()},"cocoa-source-purge").start()}
            scheduleLoadTimeout()
            open()
        }
        return JSONObject().put("ok",true)
    }

    fun fail(message: String) {
        if (finished) return
        finished = true
        Log.w(TAG, "failing: $message")
        PlaybackBus.listener?.onError(ownerId, message)
        // ExoPlayer must be released on the main thread: fail() is often called
        // from the torrent io thread.
        main.post {
            release()
            finish()
        }
    }

    fun syncControls(update:JSONObject) {
        runOnUiThread {
            if(update.has("ownerId") && update.optString("ownerId")!=ownerId)return@runOnUiThread
            update.keys().forEach {controlsState.put(it,update.opt(it))}
            episodeButton?.visibility=if((controlsState.optJSONArray("episodes")?.length() ?: 0)>0)android.view.View.VISIBLE else android.view.View.GONE
            if(update.has("sources") || update.has("sourcesError"))showSourceResults()
        }
    }
    private fun action(name:String, key:String?=null, value:String?=null) {
        val event=JSONObject().put("action",name)
        if(key!=null)event.put(key,value)
        PlaybackBus.listener?.onAction(event)
    }
    private fun showEpisodes() {
        val list=controlsState.optJSONArray("episodes") ?: org.json.JSONArray()
        if(list.length()==0)return
        showChoiceSheet("Episodes",Array(list.length()){i -> val e=list.optJSONObject(i); e?.let {"S${it.optInt("season")}  ·  E${it.optInt("episode")}     ${it.optString("name")}"} ?: "Episode ${i+1}"}) { i -> action("select-episode","videoId",list.optJSONObject(i)?.optString("id")) }
    }
    private fun showMore() {
        val casting=try{Bridge.caster(this).isCasting()}catch(_:Exception){false}
        val labels=buildList { add("Subtitles");add("Playback speed");if(controlsState.optBoolean("hasNext"))add("Next episode");add("Cast to TV");if(casting)add("Stop casting and disconnect") }
        showChoiceSheet("Playback",labels.toTypedArray()){i -> when(labels[i]) {
            "Subtitles" -> showSubtitles()
            "Playback speed" -> showChoiceSheet("Playback speed",arrayOf("0.75×","1×","1.25×","1.5×","2×")){ n -> player?.setPlaybackSpeed(floatArrayOf(.75f,1f,1.25f,1.5f,2f)[n]) }
            "Next episode" -> action("next")
            "Cast to TV" -> showCast()
            else -> Thread({try{Bridge.caster(this).stop();castStream?.close();castStream=null;runOnUiThread{player?.play();notice("Disconnected from TV")}}catch(e:Exception){notice(e.message)}}).start()
        } }
    }
    private fun dp(value:Int)= (value*resources.displayMetrics.density).toInt()
    private fun showChoiceSheet(title:String, labels:Array<String>, selected:Int=-1, onPick:(Int)->Unit) {
        val dialog=android.app.Dialog(this)
        val panel=android.widget.LinearLayout(this).apply { orientation=android.widget.LinearLayout.VERTICAL;setPadding(dp(20),dp(18),dp(20),dp(14));background=android.graphics.drawable.GradientDrawable().apply{setColor(Color.rgb(18,23,19));cornerRadius=dp(24).toFloat();setStroke(dp(1),Color.argb(35,205,233,211))} }
        panel.addView(TextView(this).apply{text=title;setTextColor(Color.WHITE);textSize=20f;typeface=SubtitleFont.peek(this@PlayerActivity);setPadding(dp(4),dp(2),dp(4),dp(12))})
        labels.forEachIndexed { i,label -> panel.addView(TextView(this).apply {
            text=(if(i==selected) "✓    " else "      ")+label;setTextColor(if(i==selected)Color.rgb(190,231,200) else Color.WHITE);textSize=15f;gravity=Gravity.CENTER_VERTICAL
            typeface=SubtitleFont.peek(this@PlayerActivity);setPadding(dp(8),0,dp(8),0);minHeight=dp(50)
            setOnClickListener{dialog.dismiss();onPick(i)}
        }) }
        val scroll=android.widget.ScrollView(this).apply{isFillViewport=true;addView(panel)}
        dialog.setContentView(scroll);dialog.window?.setBackgroundDrawableResource(android.R.color.transparent)
        dialog.show();dialog.window?.setBackgroundDrawableResource(android.R.color.transparent);dialog.window?.setLayout((resources.displayMetrics.widthPixels-dp(32)).coerceAtMost(dp(480)),ViewGroup.LayoutParams.WRAP_CONTENT)
    }
    private fun showSubtitles() {
        val rows=controlsState.optJSONArray("subtitles") ?: org.json.JSONArray()
        val groups=linkedMapOf<String,MutableList<Triple<String,String,String>>>()
        for(i in 0 until rows.length()) rows.optJSONObject(i)?.let { row ->
            val tag=row.optString("lang")
            val lang=try{java.util.Locale.forLanguageTag(tag).getDisplayLanguage(java.util.Locale.ENGLISH).ifBlank{"Other"}}catch(_:Exception){"Other"}
            groups.getOrPut(lang){mutableListOf()}.add(Triple(row.optString("label"),row.optString("key"),tag))
        }
        val dialog=android.app.Dialog(this)
        val panel=android.widget.LinearLayout(this).apply {orientation=android.widget.LinearLayout.VERTICAL;setPadding(dp(18),dp(18),dp(18),dp(18));background=android.graphics.drawable.GradientDrawable().apply{setColor(Color.rgb(18,23,19));cornerRadius=dp(24).toFloat();setStroke(dp(1),Color.argb(35,205,233,211))}}
        panel.addView(TextView(this).apply{text="Subtitles";setTextColor(Color.WHITE);textSize=20f;typeface=SubtitleFont.peek(this@PlayerActivity);setPadding(dp(4),0,dp(4),dp(10))})
        val search=android.widget.EditText(this).apply{hint="Search languages";setSingleLine(true);textSize=14f;setTextColor(Color.WHITE);setHintTextColor(Color.GRAY);typeface=SubtitleFont.peek(this@PlayerActivity);setPadding(dp(14),0,dp(14),0);background=android.graphics.drawable.GradientDrawable().apply{setColor(Color.rgb(31,39,33));cornerRadius=dp(12).toFloat()};layoutParams=android.widget.LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,dp(46)).apply{bottomMargin=dp(10)}}
        panel.addView(search)
        val list=android.widget.LinearLayout(this).apply{orientation=android.widget.LinearLayout.VERTICAL}
        val scroller=android.widget.ScrollView(this).apply{addView(list);layoutParams=android.widget.LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,0,1f)}
        panel.addView(scroller)
        val active=controlsState.optString("subtitleKey","")
        fun draw(needle:String="") {
            list.removeAllViews()
            fun option(label:String,key:String) { list.addView(TextView(this).apply {
                val chosen=key==active;text=(if(chosen) "✓   " else "      ")+label;setTextColor(if(chosen)Color.rgb(190,231,200)else Color.WHITE);textSize=14f;typeface=SubtitleFont.peek(this@PlayerActivity);gravity=Gravity.CENTER_VERTICAL;setPadding(dp(10),0,dp(8),0);minHeight=dp(47)
                setOnClickListener{dialog.dismiss();action("select-subtitle","key",key)}
            }) }
            option("Off","")
            val filtered=groups.mapValues{(_,items)->items.filter{(label,_,tag)->"$label $tag".contains(needle,true)}}.filterValues{it.isNotEmpty()}
                .toSortedMap(compareBy<String>{if(it.equals("English",true))0 else 1}.thenBy{it.lowercase()})
            filtered.forEach{(language,entries)->
                list.addView(TextView(this).apply{text="$language  ·  ${entries.size}";setTextColor(Color.rgb(160,191,166));textSize=11f;typeface=SubtitleFont.peek(this@PlayerActivity);setPadding(dp(10),dp(10),dp(10),dp(5))})
                entries.forEach{(label,key,_)->option(label,key)}
            }
            if(filtered.isEmpty() && needle.isNotBlank())list.addView(TextView(this).apply{text="No match";setTextColor(Color.LTGRAY);gravity=Gravity.CENTER;minHeight=dp(54)})
            if(groups.isEmpty())list.addView(TextView(this).apply{text="No subtitles found for this source";setTextColor(Color.LTGRAY);gravity=Gravity.CENTER;minHeight=dp(54)})
        }
        draw()
        search.addTextChangedListener(object:android.text.TextWatcher{override fun beforeTextChanged(s:CharSequence?,start:Int,count:Int,after:Int){};override fun onTextChanged(s:CharSequence?,start:Int,before:Int,count:Int){draw(s?.toString()?.trim().orEmpty())};override fun afterTextChanged(s:android.text.Editable?) {}})
        dialog.setContentView(panel);dialog.show();dialog.window?.setBackgroundDrawableResource(android.R.color.transparent);dialog.window?.setLayout((resources.displayMetrics.widthPixels-dp(32)).coerceAtMost(dp(480)),(resources.displayMetrics.heightPixels*0.72f).toInt())
    }
    private fun notice(message:String?) {runOnUiThread{android.widget.Toast.makeText(this,message ?: "Please try again",android.widget.Toast.LENGTH_LONG).show()}}
    private fun showCast() {
        val progress=android.app.ProgressDialog(this).apply {setMessage("Looking for TVs on your Wi-Fi…");setCancelable(false);show()}
        Thread({
            try {
                val cast=Bridge.caster(this)
                val devices=cast.discover()
                runOnUiThread {
                    progress.dismiss()
                    if(isFinishing)return@runOnUiThread
                    if(devices.length()==0){notice("No TVs found. Connect both devices to the same Wi-Fi.");return@runOnUiThread}
                    android.app.AlertDialog.Builder(this).setTitle("Cast to TV").setItems(Array(devices.length()){i ->devices.getJSONObject(i).optString("name")}) {_,i ->
                        Thread({try {
                            cast.play(JSONObject().put("deviceId",devices.getJSONObject(i).getString("id")).put("url",castingUrl()).put("mimeType",castingMimeType()).put("title",payload.optString("title","CocoaStream")))
                            runOnUiThread{player?.pause();notice("Playing on your TV. Keep CocoaStream open while casting.")}
                        }catch(e:Exception){notice(e.message)}}).start()
                    }.setNegativeButton("Cancel",null).show()
                }
            }catch(e:Exception){runOnUiThread{progress.dismiss();notice(e.message)}}
        },"cocoa-cast-discover").start()
    }
    @Synchronized fun castingUrl():String {
        engine?.let {eng ->
            if(castStream==null)castStream=CastStream(eng)
            return castStream!!.url()
        }
        return currentUri?.toString().orEmpty()
    }
    private fun castingMimeType():String {
        val stream=payload.optJSONObject("stream")
        val source=stream?.optString("url").orEmpty()
        val ext=(engine?.resolvedPath?.extension ?: source.substringBefore('?').substringAfterLast('.',"")).lowercase()
        return when {
            source.contains(".m3u8",true) -> "application/x-mpegURL"
            source.contains(".mpd",true) -> "application/dash+xml"
            ext=="mkv" -> "video/x-matroska"
            ext=="webm" -> "video/webm"
            ext in listOf("mov","qt") -> "video/quicktime"
            ext=="avi" -> "video/x-msvideo"
            else -> "video/mp4"
        }
    }

    private fun finishPlayback(ended: Boolean) {
        if (finished) return
        finished = true
        val position = player?.currentPosition ?: 0L
        val duration = try {
            player?.duration ?: 0L
        } catch (t: Throwable) {
            0L
        }
        Log.i(TAG, "closed ownerId=$ownerId position=$position duration=$duration ended=$ended")
        PlaybackBus.listener?.onClosed(ownerId, position, if (duration < 0) 0 else duration, ended)
        release()
        finish()
    }

    /** Used when a newer player replaces this one: no stats, no callbacks. */
    private fun abandon() {
        finished = true
        release()
        finish()
    }

    private fun release() {
        try { if(Bridge.caster(this).isCasting()) Thread({try{Bridge.caster(this).stop()}catch(_:Exception){}} ,"cocoa-cast-stop-on-close").start() } catch(_:Exception){}
        castStream?.close();castStream=null
        io.shutdownNow()
        main.removeCallbacksAndMessages(null)
        try {
            player?.release()
        } catch (t: Throwable) {
        }
        player = null
        // Stop the swarm right here, not on the io queue: that queue may be
        // blocked inside engine.start() waiting for metadata, and a torrent
        // session that outlives its player is exactly what starved the next
        // attempt.
        val eng = engine
        engine = null
        // Stop first, then delete. Deleting under a live session leaves libtorrent
        // writing into files that no longer exist, and Sam's rule for this cache is
        // that it may hold a little while a movie plays but must not stack up: it
        // goes when the player closes.
        Thread({ eng?.purge() }, "cocoa-cache-purge").start()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        finishPlayback(false)
    }

    override fun onDestroy() {
        if (current === this) current = null
        release()
        super.onDestroy()
    }
}
