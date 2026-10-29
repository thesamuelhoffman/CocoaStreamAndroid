package app.cocoastream.android

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat

/**
 * The whole UI is the CocoaStream web app, served from assets over a real
 * https origin so ES modules, localStorage and the CSP all behave.
 */
class MainActivity : Activity() {
    private lateinit var webView: WebView
    private var bridge: Bridge? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val previous=Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler {thread,error ->
            try {java.io.File(filesDir,"last-crash.txt").writeText(error.stackTraceToString().take(12000))}catch(_:Throwable){}
            previous?.uncaughtException(thread,error)
        }
        val report=java.io.File(filesDir,"last-crash.txt")
        if(report.exists()) {showStartupFailure(report.readText());return}
        try {startApp(savedInstanceState)}catch(error:Throwable){showStartupFailure(error.stackTraceToString())}
    }

    private fun showStartupFailure(message:String) {
        val layout=android.widget.LinearLayout(this).apply {
            orientation=android.widget.LinearLayout.VERTICAL
            setPadding(32,40,32,24);setBackgroundColor(Color.rgb(9,14,10))
        }
        layout.addView(android.widget.TextView(this).apply {text="CocoaStream could not start";textSize=23f;setTextColor(Color.WHITE)})
        layout.addView(android.widget.TextView(this).apply {text="Please send the error below so we can fix it.";setPadding(0,16,0,16);setTextColor(Color.LTGRAY)})
        val details="Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})\n${Build.SUPPORTED_ABIS.joinToString()}\n\n"+message.take(10000)
        val scroll=android.widget.ScrollView(this)
        scroll.addView(android.widget.TextView(this).apply {text=details;textSize=12f;setTextColor(Color.WHITE);setTextIsSelectable(true)})
        layout.addView(scroll,android.widget.LinearLayout.LayoutParams(-1,0,1f))
        layout.addView(android.widget.Button(this).apply {text="Copy error";setOnClickListener {
            val clipboard=getSystemService(CLIPBOARD_SERVICE) as android.content.ClipboardManager
            clipboard.setPrimaryClip(android.content.ClipData.newPlainText("CocoaStream startup",details))
            android.widget.Toast.makeText(this@MainActivity,"Error copied",android.widget.Toast.LENGTH_SHORT).show()
        }})
        layout.addView(android.widget.Button(this).apply {text="Try again";setOnClickListener {java.io.File(filesDir,"last-crash.txt").delete();recreate()}})
        setContentView(layout)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun startApp(savedInstanceState:Bundle?) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            window.attributes = window.attributes.apply {
                layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
            }
        }
        WebView.setWebContentsDebuggingEnabled((applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0)
        webView = WebView(this)
        webView.setBackgroundColor(Color.parseColor("#0b0b0f"))
        val settings = webView.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.databaseEnabled = true
        settings.mediaPlaybackRequiresUserGesture = false
        settings.cacheMode = WebSettings.LOAD_DEFAULT
        settings.allowFileAccess = false
        settings.allowContentAccess = false
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        val television=(resources.configuration.uiMode and android.content.res.Configuration.UI_MODE_TYPE_MASK)==android.content.res.Configuration.UI_MODE_TYPE_TELEVISION
        settings.userAgentString = settings.userAgentString + if(television) " CocoaStreamTV/1.1" else " CocoaStreamAndroid/1.1"

        val b = Bridge(this, webView)
        bridge = b
        webView.addJavascriptInterface(b, "Native")

        val assetLoader = WebViewAssetLoader.Builder()
            .setDomain("appassets.androidplatform.net")
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        webView.webViewClient = object : WebViewClientCompat() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                assetLoader.shouldInterceptRequest(request.url)

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url
                if (url.scheme == "https" && url.host == "appassets.androidplatform.net" && url.path?.startsWith("/assets/app/") == true) return false
                if (!request.isForMainFrame || url.scheme !in listOf("http", "https", "magnet", "stremio")) return true
                return try {
                    startActivity(Intent(Intent.ACTION_VIEW, url))
                    true
                } catch (t: Throwable) {
                    true
                }
            }
        }

        setContentView(webView)
        PlaybackBus.listener = b
        webView.loadUrl("https://appassets.androidplatform.net/assets/app/index.html")
    }

    override fun onResume() {
        super.onResume()
        bridge?.let { PlaybackBus.listener = it }
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if(!::webView.isInitialized){super.onBackPressed();return}
        webView.evaluateJavascript(
            "(function(){try{return (window.__csBack&&window.__csBack())?'handled':'root'}catch(e){return 'root'}})()"
        ) { value ->
            if (value == null || value.contains("root")) {
                @Suppress("DEPRECATION")
                super.onBackPressed()
            }
        }
    }

    override fun onDestroy() {
        if (PlaybackBus.listener === bridge) PlaybackBus.listener = null
        bridge?.destroy()
        if(::webView.isInitialized){webView.removeJavascriptInterface("Native");webView.destroy()}
        super.onDestroy()
    }
}
