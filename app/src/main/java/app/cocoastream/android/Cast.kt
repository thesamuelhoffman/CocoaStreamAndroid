package app.cocoastream.android

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.MediaType.Companion.toMediaType
import org.json.JSONArray
import org.json.JSONObject
import java.io.DataInputStream
import java.io.DataOutputStream
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.URI
import java.net.Socket
import java.security.SecureRandom
import java.security.cert.X509Certificate
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocket
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager
import javax.xml.parsers.DocumentBuilderFactory

/** LAN discovery and real receiver commands. No companion application is required. */
class Cast(private val context:Context) {
    private val devices=ConcurrentHashMap<String,JSONObject>()
    private val http=OkHttpClient.Builder().callTimeout(7,TimeUnit.SECONDS).build()
    private var channel:SSLSocket?=null
    private var castDestination=""
    private var castSession=0
    private var active:JSONObject?=null
    @Synchronized fun isCasting():Boolean = active != null
    private fun local(host:String):Boolean = try {
        val address=InetAddress.getByName(host)
        address.isSiteLocalAddress || address.isLinkLocalAddress
    }catch(_:Exception){false}
    @Synchronized fun discover():JSONArray {
        devices.clear()
        val manager=context.getSystemService(Context.NSD_SERVICE) as NsdManager
        val listeners=listOf("_googlecast._tcp.","_airplay._tcp.").map { type ->
            object:NsdManager.DiscoveryListener {
                override fun onDiscoveryStarted(t:String){}
                override fun onDiscoveryStopped(t:String){}
                override fun onStartDiscoveryFailed(t:String,error:Int){}
                override fun onStopDiscoveryFailed(t:String,error:Int){}
                override fun onServiceLost(info:NsdServiceInfo){}
                override fun onServiceFound(info:NsdServiceInfo) {
                    @Suppress("DEPRECATION")
                    manager.resolveService(info,object:NsdManager.ResolveListener {
                        override fun onResolveFailed(service:NsdServiceInfo,error:Int){}
                        override fun onServiceResolved(service:NsdServiceInfo) {
                            val host=service.host?.hostAddress ?: return
                            if(!local(host))return
                            val protocol=if(type.startsWith("_googlecast")) "chromecast" else "airplay"
                            val id="$protocol:$host:${service.port}"
                            val friendly=service.attributes["fn"]?.toString(Charsets.UTF_8) ?: service.serviceName
                            devices[id]=JSONObject().put("id",id).put("name",friendly).put("protocol",protocol).put("host",host).put("port",service.port)
                        }
                    })
                }
            }.also { try{manager.discoverServices(type,NsdManager.PROTOCOL_DNS_SD,it)}catch(_:Exception){} }
        }
        try { ssdp() } finally { listeners.forEach {try{manager.stopServiceDiscovery(it)}catch(_:Exception){}} }
        return JSONArray(devices.values.map { JSONObject().put("id",it.getString("id")).put("name",it.getString("name")).put("protocol",it.getString("protocol")) })
    }
    private fun ssdp() {
        val descriptions=linkedSetOf<String>()
        val multicast=try {
            val wifi=context.applicationContext.getSystemService(Context.WIFI_SERVICE) as android.net.wifi.WifiManager
            wifi.createMulticastLock("CocoaStreamCastDiscovery").apply {setReferenceCounted(false);acquire()}
        } catch(_:Exception){null}
        try { DatagramSocket().use { socket ->
            socket.soTimeout=250
            val message=("M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 2\r\nST: urn:schemas-upnp-org:service:AVTransport:1\r\n\r\n").toByteArray()
            socket.send(DatagramPacket(message,message.size,InetAddress.getByName("239.255.255.250"),1900))
            val end=System.currentTimeMillis()+2500
            while(System.currentTimeMillis()<end) {
                try {
                    val packet=DatagramPacket(ByteArray(8192),8192);socket.receive(packet)
                    val location=String(packet.data,0,packet.length).lineSequence().firstOrNull {it.startsWith("location:",true)}?.substringAfter(':')?.trim() ?: continue
                    val uri=URI(location)
                    if(uri.scheme !in listOf("http","https") || !local(uri.host))continue
                    if(InetAddress.getByName(uri.host)!=packet.address)continue
                    descriptions.add(location)
                }catch(_:java.net.SocketTimeoutException){}
            }
        }
        descriptions.take(12).forEach { url -> try {
            http.newCall(Request.Builder().url(url).build()).execute().use { r ->
                val factory=DocumentBuilderFactory.newInstance()
                factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl",true)
                val doc=factory.newDocumentBuilder().parse(r.body!!.byteStream())
                val services=doc.getElementsByTagName("service")
                for(i in 0 until services.length) {
                    val element=services.item(i) as org.w3c.dom.Element
                    val service=element.getElementsByTagName("serviceType").item(0)?.textContent ?: continue
                    if(!service.contains(":AVTransport:"))continue
                    val control=URI(url).resolve(element.getElementsByTagName("controlURL").item(0).textContent).toString()
                    if(URI(control).host!=URI(url).host)continue
                    val id="dlna:$control"
                    devices[id]=JSONObject().put("id",id).put("name",doc.getElementsByTagName("friendlyName").item(0)?.textContent ?: "Smart TV")
                        .put("protocol","dlna").put("control",control).put("service",service)
                }
            }
        }catch(_:Exception){} }
        } finally {try{if(multicast?.isHeld==true)multicast.release()}catch(_:Exception){}}
    }
    private fun xml(s:String)=s.replace("&","&amp;").replace("<","&lt;").replace(">","&gt;").replace("\"","&quot;")
    private fun soap(device:JSONObject,action:String,body:String) {
        val service=device.getString("service")
        val envelope="<?xml version=\"1.0\"?><s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\"><s:Body><u:$action xmlns:u=\"$service\">$body</u:$action></s:Body></s:Envelope>"
        val request=Request.Builder().url(device.getString("control")).header("SOAPAction","\"$service#$action\"")
            .post(envelope.toRequestBody("text/xml; charset=utf-8".toMediaType())).build()
        http.newCall(request).execute().use { require(it.isSuccessful) {"The TV refused $action (HTTP ${it.code})."} }
    }
    @Synchronized fun play(p:JSONObject):JSONObject {
        val device=devices[p.optString("deviceId")] ?: throw IllegalArgumentException("Find your TV again before casting.")
        val current=PlayerActivity.current
        val url=p.optString("url").ifBlank {current?.castingUrl().orEmpty()}
        val mime=p.optString("mimeType").ifBlank {if(url.contains(".m3u8",true))"application/x-mpegURL" else "video/mp4"}
        require(url.startsWith("http://") || url.startsWith("https://")) {"This source has no castable address."}
        when(device.getString("protocol")) {
            "dlna" -> {
                val metadata="<DIDL-Lite xmlns=\"urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:upnp=\"urn:schemas-upnp-org:metadata-1-0/upnp/\"><item id=\"0\" parentID=\"0\" restricted=\"1\"><dc:title>${xml(p.optString("title","CocoaStream"))}</dc:title><upnp:class>object.item.videoItem</upnp:class><res protocolInfo=\"http-get:*:video/*:*\">${xml(url)}</res></item></DIDL-Lite>"
                    soap(device,"SetAVTransportURI","<InstanceID>0</InstanceID><CurrentURI>${xml(url)}</CurrentURI><CurrentURIMetaData>${xml(metadata)}</CurrentURIMetaData>")
                soap(device,"Play","<InstanceID>0</InstanceID><Speed>1</Speed>")
            }
            "airplay" -> {
                val target="http://${device.getString("host")}:${device.getInt("port")}/play"
                http.newCall(Request.Builder().url(target).post("Content-Location: $url\r\nStart-Position: 0\r\n".toRequestBody("text/parameters".toMediaType())).build()).execute().use {
                    require(it.isSuccessful){"AirPlay requires pairing or refused this video (HTTP ${it.code})."}
                }
            }
            "chromecast" -> google(device,url,p.optString("title","CocoaStream"),mime)
        }
        active=device
        return JSONObject().put("ok",true).put("deviceId",device.getString("id"))
    }
    private fun send(namespace:String,payload:JSONObject,destination:String="receiver-0") {
        val socket=channel ?: throw IllegalStateException("TV connection closed.")
        val bytes=CastWire.encode("sender-cocoa",destination,"urn:x-cast:$namespace",payload.toString())
        synchronized(socket) { DataOutputStream(socket.outputStream).apply {writeInt(bytes.size);write(bytes);flush()} }
    }
    private fun receive(socket:SSLSocket = channel ?: throw IllegalStateException("TV connection closed.")):JSONObject {
        val input=DataInputStream(socket.inputStream)
        while(true) {
            val size=input.readInt();require(size in 1..524288){"Invalid TV response."}
            val bytes=ByteArray(size);input.readFully(bytes)
            val fields=CastWire.decode(bytes)
            val value=JSONObject(fields[6] ?: "{}")
            if(value.optString("type")=="PING") {
                val reply=CastWire.encode("sender-cocoa",fields[2] ?: "receiver-0","urn:x-cast:com.google.cast.tp.heartbeat","{\"type\":\"PONG\"}")
                synchronized(socket){DataOutputStream(socket.outputStream).apply{writeInt(reply.size);write(reply);flush()}}
                continue
            }
            return value
        }
    }
    private fun google(device:JSONObject,url:String,title:String,mime:String) {
        channel?.close();channel=null;castDestination="";castSession=0
        // Cast receivers use local self-signed certificates. This context is used only
        // for a device discovered on the LAN; it never handles app/API credentials.
        val trust=object:X509TrustManager {
            override fun getAcceptedIssuers()=emptyArray<X509Certificate>()
            override fun checkClientTrusted(c:Array<out X509Certificate>?,a:String?){}
            override fun checkServerTrusted(c:Array<out X509Certificate>?,a:String?){}
        }
        val tls=SSLContext.getInstance("TLS").apply{init(null,arrayOf<TrustManager>(trust),SecureRandom())}
        val raw=Socket().apply{connect(java.net.InetSocketAddress(device.getString("host"),device.getInt("port")),5000)}
        channel=(tls.socketFactory.createSocket(raw,device.getString("host"),device.getInt("port"),true) as SSLSocket).apply {soTimeout=7000;startHandshake()}
        send("com.google.cast.tp.connection",JSONObject().put("type","CONNECT"))
        send("com.google.cast.receiver",JSONObject().put("type","LAUNCH").put("appId","CC1AD845").put("requestId",1))
        val deadline=System.currentTimeMillis()+10000
        while(System.currentTimeMillis()<deadline) {
            val response=receive()
            val app=response.optJSONObject("status")?.optJSONArray("applications")?.optJSONObject(0) ?: continue
            castDestination=app.getString("transportId");break
        }
        require(castDestination.isNotBlank()){ "The Chromecast receiver did not start." }
        send("com.google.cast.tp.connection",JSONObject().put("type","CONNECT"),castDestination)
        send("com.google.cast.media",JSONObject().put("type","LOAD").put("requestId",2).put("autoplay",true)
            .put("media",JSONObject().put("contentId",url).put("contentType",mime).put("streamType","BUFFERED")
                .put("metadata",JSONObject().put("metadataType",1).put("title",title))),castDestination)
        val sessionSocket=channel!!
        val loadDeadline=System.currentTimeMillis()+10000
        while(System.currentTimeMillis()<loadDeadline && castSession==0) {
            val response=receive(sessionSocket)
            if(response.optInt("requestId",-1)!=2)continue
            require(response.optString("type") !in listOf("LOAD_FAILED","INVALID_REQUEST")){"Chromecast cannot play this source's format."}
            if(response.optString("type")=="MEDIA_STATUS")castSession=response.optJSONArray("status")?.optJSONObject(0)?.optInt("mediaSessionId") ?: 0
        }
        require(castSession>0){"Chromecast did not confirm playback."}
        Thread({
            try {while(!sessionSocket.isClosed)receive(sessionSocket)}
            catch(_:Exception) {try{sessionSocket.close()}catch(_:Exception){};if(channel===sessionSocket)channel=null}
        },"cocoa-cast").start()
    }
    @Synchronized fun stop():JSONObject {
        try { active?.let {device ->when(device.getString("protocol")) {
            "dlna" -> soap(device,"Stop","<InstanceID>0</InstanceID>")
            "airplay" -> http.newCall(Request.Builder().url("http://${device.getString("host")}:${device.getInt("port")}/stop").post(ByteArray(0).toRequestBody(null)).build()).execute().close()
            "chromecast" -> if(castSession>0)send("com.google.cast.media",JSONObject().put("type","STOP").put("requestId",3).put("mediaSessionId",castSession),castDestination)
        }} } finally {try{channel?.close()}catch(_:Exception){};channel=null;active=null;castSession=0;castDestination=""}
        return JSONObject().put("ok",true)
    }
}
