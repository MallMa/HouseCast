package io.github.housecast.core

import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.atomic.AtomicLong

/** An in-memory speaker: answers the control calls the app makes and pulls audio like a real player. */
class TestSpeaker(private val host: String, private val id: String = "RINCON_TEST01400") : Transport {
    @Volatile var uri = "x-sonos-spotify:before"
    @Volatile var metadata = ""
    @Volatile var state = "PLAYING"
    @Volatile var volume = 20
    @Volatile var mute = false
    val received = AtomicLong()
    val audio = ByteArrayOutputStream()
    val actions = java.util.Collections.synchronizedList(ArrayList<String>())
    @Volatile var contentType: String? = null
    @Volatile private var reader: Thread? = null
    @Volatile private var connection: HttpURLConnection? = null

    private fun ok(action: String, inner: String) = HttpResponse(
        200, emptyMap(),
        "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\"><s:Body>" +
            "<u:${action}Response xmlns:u=\"urn:x\">$inner</u:${action}Response></s:Body></s:Envelope>",
        1.0,
    )

    private fun stopReading() {
        connection?.disconnect()
        reader?.interrupt()
        reader = null
    }

    private fun startReading() {
        stopReading()
        val url = uri
        if (!url.startsWith("http:")) return
        reader = Thread {
            try {
                val c = URL(url).openConnection() as HttpURLConnection
                connection = c
                contentType = c.contentType
                val buffer = ByteArray(8192)
                c.inputStream.use { input ->
                    while (true) {
                        val n = input.read(buffer)
                        if (n < 0) break
                        if (audio.size() < 400_000) synchronized(audio) { audio.write(buffer, 0, n) }
                        received.addAndGet(n.toLong())
                    }
                }
            } catch (_: Exception) {
            }
        }.apply { isDaemon = true; start() }
    }

    override suspend fun request(
        host: String, path: String, method: String, headers: Map<String, String>, body: String, timeoutMs: Long,
    ): HttpResponse {
        if (path == "/xml/device_description.xml") return HttpResponse(200, emptyMap(), description(id, "Kitchen", "Sonos One"), 1.0)
        if (method == "SUBSCRIBE") return HttpResponse(200, mapOf("sid" to "uuid:sub"), "", 1.0)
        if (method == "UNSUBSCRIBE") return HttpResponse(200, emptyMap(), "", 1.0)
        val action = headers.getValue("SOAPACTION").trim('"').substringAfter('#')
        actions.add(action)
        val args = soapData(body)
        return when (action) {
            "GetVolume" -> ok(action, "<CurrentVolume>$volume</CurrentVolume>")
            "GetMute" -> ok(action, "<CurrentMute>${if (mute) 1 else 0}</CurrentMute>")
            "SetVolume" -> ok(action, "").also { volume = args.getValue("DesiredVolume").toInt() }
            "SetMute" -> ok(action, "").also { mute = args["DesiredMute"] == "1" }
            "GetTransportInfo" -> ok(action, "<CurrentTransportState>$state</CurrentTransportState>")
            "GetMediaInfo" -> ok(action, "<CurrentURI>${escapeXml(uri)}</CurrentURI><CurrentURIMetaData>${escapeXml(metadata)}</CurrentURIMetaData>")
            "GetZoneGroupState" -> ok(
                action,
                "<ZoneGroupState>" + escapeXml(
                    "<ZoneGroupState><ZoneGroups><ZoneGroup Coordinator=\"$id\"><ZoneGroupMember UUID=\"$id\" " +
                        "ZoneName=\"Kitchen\" Location=\"http://${this.host}:1400/xml/device_description.xml\"/>" +
                        "</ZoneGroup></ZoneGroups></ZoneGroupState>",
                ) + "</ZoneGroupState>",
            )
            "SetAVTransportURI" -> ok(action, "").also {
                stopReading()
                uri = args["CurrentURI"] ?: ""
                metadata = args["CurrentURIMetaData"] ?: ""
                state = "STOPPED"
            }
            "Play" -> ok(action, "").also {
                state = "PLAYING"
                startReading()
            }
            "Stop", "Pause" -> ok(action, "").also {
                state = "STOPPED"
                stopReading()
            }
            else -> ok(action, "")
        }
    }

    companion object {
        fun description(id: String, room: String, model: String) =
            """<?xml version="1.0"?><root xmlns="urn:schemas-upnp-org:device-1-0"><device>
            <manufacturer>Sonos, Inc.</manufacturer><roomName>$room</roomName><modelName>$model</modelName>
            <softwareVersion>80.1</softwareVersion><UDN>uuid:$id</UDN>
            <serviceList><service><serviceType>urn:schemas-upnp-org:service:ZoneGroupTopology:1</serviceType>
              <controlURL>/ZoneGroupTopology/Control</controlURL><eventSubURL>/ZoneGroupTopology/Event</eventSubURL></service></serviceList>
            <deviceList><device><serviceList>
              <service><serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType>
                <controlURL>/MediaRenderer/RenderingControl/Control</controlURL><eventSubURL>/MediaRenderer/RenderingControl/Event</eventSubURL></service>
              <service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>
                <controlURL>/MediaRenderer/AVTransport/Control</controlURL><eventSubURL>/MediaRenderer/AVTransport/Event</eventSubURL></service>
            </serviceList></device></deviceList></device></root>"""
    }
}
