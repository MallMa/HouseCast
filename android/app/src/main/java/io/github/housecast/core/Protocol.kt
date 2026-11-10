package io.github.housecast.core

import org.w3c.dom.Element
import org.xml.sax.InputSource
import java.io.StringReader
import java.net.URI
import javax.xml.parsers.DocumentBuilderFactory

/** A speaker answered, but with a fault or something that is not a valid reply. */
class SpeakerException(message: String, val code: String? = null) : Exception(message)

class Service(val type: String, val control: String, val event: String)

class DeviceDescription(
    val id: String,
    val host: String,
    val name: String,
    val model: String,
    val version: String?,
    val services: Map<String, Service>,
)

data class Group(val coordinator: String, val ids: List<String>)

class Member(
    val id: String,
    val name: String,
    val host: String,
    val hidden: Boolean,
    val coordinator: String,
    val children: List<String>,
)

class Topology(val groups: List<Group>, val members: List<Member>)

data class SourceInfo(val kind: String, val title: String)

// DIDL item id that marks streams created by Housecast (desktop or phone), so
// an ended stream left on a speaker is recognized instead of being restored as
// a playable source.
const val STREAM_ITEM_ID = "housecast"

private val FORBIDDEN_XML = Regex("<!DOCTYPE|<!ENTITY", RegexOption.IGNORE_CASE)

fun parseXml(text: String): Element {
    if (text.length > 2_000_000 || FORBIDDEN_XML.containsMatchIn(text))
        throw SpeakerException("Invalid device response.")
    try {
        val factory = DocumentBuilderFactory.newInstance()
        factory.isNamespaceAware = true
        val builder = factory.newDocumentBuilder()
        builder.setErrorHandler(null)
        return builder.parse(InputSource(StringReader(text))).documentElement
    } catch (e: Exception) {
        throw SpeakerException("Invalid device response.")
    }
}

private val Element.local: String
    get() = localName ?: nodeName.substringAfter(':')

fun Element.elements(): List<Element> {
    val out = ArrayList<Element>()
    val nodes = childNodes
    for (i in 0 until nodes.length) (nodes.item(i) as? Element)?.let(out::add)
    return out
}

fun Element.children(name: String): List<Element> = elements().filter { it.local == name }
fun Element.child(name: String): Element? = elements().firstOrNull { it.local == name }
fun Element.text(name: String): String? = child(name)?.textContent

fun escapeXml(value: Any?): String {
    val text = value?.toString() ?: ""
    val out = StringBuilder(text.length + 16)
    for (c in text) when (c) {
        '<' -> out.append("&lt;")
        '>' -> out.append("&gt;")
        '&' -> out.append("&amp;")
        '"' -> out.append("&quot;")
        '\'' -> out.append("&apos;")
        else -> out.append(c)
    }
    return out.toString()
}

fun envelope(type: String, action: String, args: Map<String, Any?> = emptyMap()): String {
    val body = args.entries.joinToString("") { (k, v) -> "<$k>${escapeXml(v)}</$k>" }
    return "<?xml version=\"1.0\"?><s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" " +
        "s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\"><s:Body>" +
        "<u:$action xmlns:u=\"$type\">$body</u:$action></s:Body></s:Envelope>"
}

/** Returns the out-arguments of a SOAP response, or throws on a fault. */
fun soapData(text: String): Map<String, String> {
    val root = parseXml(text)
    val body = (if (root.local == "Envelope") root.child("Body") else null)
        ?: throw SpeakerException("Speaker returned an invalid response.")
    body.child("Fault")?.let { fault ->
        val error = fault.child("detail")?.child("UPnPError")
        val code = error?.text("errorCode") ?: "unknown"
        val description = error?.text("errorDescription") ?: ""
        throw SpeakerException("Speaker refused the command ($code). $description".trim(), code)
    }
    val response = body.elements().firstOrNull() ?: return emptyMap()
    return response.elements().associate { it.local to it.textContent }
}

fun describe(text: String, host: String): DeviceDescription {
    val parsed = parseXml(text)
    val root = if (parsed.local == "root") parsed.child("device") else null
    val udn = root?.text("UDN") ?: ""
    if (root == null || root.text("manufacturer")?.contains("Sonos") != true || !udn.startsWith("uuid:RINCON_"))
        throw SpeakerException("This address does not identify as a compatible speaker.")
    val services = LinkedHashMap<String, Service>()
    fun walk(device: Element) {
        for (s in device.child("serviceList")?.children("service").orEmpty()) {
            val type = s.text("serviceType") ?: continue
            val control = s.text("controlURL") ?: ""
            val event = s.text("eventSubURL") ?: ""
            for (p in listOf(control, event))
                if (!p.startsWith("/") || p.startsWith("//"))
                    throw SpeakerException("Unexpected speaker service path.")
            val parts = type.split(":")
            if (parts.size < 2) continue
            services[parts[parts.size - 2]] = Service(type, control, event)
        }
        for (child in device.child("deviceList")?.children("device").orEmpty()) walk(child)
    }
    walk(root)
    return DeviceDescription(
        id = udn.removePrefix("uuid:"),
        host = host,
        name = root.text("roomName")?.takeIf { it.isNotEmpty() } ?: root.text("friendlyName") ?: "Speaker",
        model = root.text("modelName") ?: "",
        version = root.text("softwareVersion"),
        services = services,
    )
}

private fun hostOf(location: String): String = URI(location).host ?: throw SpeakerException("Invalid device response.")

fun topology(text: String): Topology {
    val data = parseXml(text)
    val groups = ArrayList<Group>()
    val members = ArrayList<Member>()
    if (data.local != "ZoneGroupState") return Topology(groups, members)
    for (g in data.child("ZoneGroups")?.children("ZoneGroup").orEmpty()) {
        val coordinator = g.getAttribute("Coordinator")
        val ids = ArrayList<String>()
        for (m in g.children("ZoneGroupMember")) {
            val satellites = m.children("Satellite")
            val entry = Member(
                id = m.getAttribute("UUID"),
                name = m.getAttribute("ZoneName"),
                host = hostOf(m.getAttribute("Location")),
                hidden = m.getAttribute("Invisible") == "1",
                coordinator = coordinator,
                children = satellites.map { it.getAttribute("UUID") },
            )
            members.add(entry)
            if (!entry.hidden) ids.add(entry.id)
            for (sat in satellites)
                members.add(
                    Member(
                        id = sat.getAttribute("UUID"),
                        name = sat.getAttribute("ZoneName"),
                        host = hostOf(sat.getAttribute("Location")),
                        hidden = true,
                        coordinator = entry.id,
                        children = emptyList(),
                    ),
                )
        }
        if (ids.isNotEmpty()) groups.add(Group(coordinator, ids))
    }
    return Topology(groups, members)
}

private val HOME_THEATER = Regex("\\b(Arc|Beam|Ray|Playbar|Playbase)\\b")

// Soundbars/home-theater players are preferred as group coordinators so their
// TV input and bonded surrounds keep working while grouped.
fun isHomeTheater(model: String?, services: Map<String, Service>?): Boolean =
    services?.containsKey("HTControl") == true || HOME_THEATER.containsMatchIn(model ?: "")

private val STREAM_PATH = Regex("^/audio/[a-f0-9-]{36}/desktop\\.(flac|wav)$")

private fun didlItem(metadata: String): Element? {
    if (metadata.isEmpty()) return null
    val root = try {
        parseXml(metadata)
    } catch (e: SpeakerException) {
        return null
    }
    return if (root.local == "DIDL-Lite") root.child("item") else null
}

/** True for a stream URL that some Housecast instance served, running or not. */
fun isHousecastStream(uri: String, metadata: String, localAddress: String? = null): Boolean {
    return try {
        val u = URI(uri)
        u.scheme == "http" &&
            isPrivate(u.host ?: "") &&
            (localAddress == null || u.host == localAddress) &&
            STREAM_PATH.matches(u.path ?: "") &&
            didlItem(metadata)?.getAttribute("id") == STREAM_ITEM_ID
    } catch (e: Exception) {
        false
    }
}

fun sourceInfo(uri: String, metadata: String, activeUri: String? = null, localAddress: String? = null): SourceInfo {
    var title = ""
    var kind = "music"
    didlItem(metadata)?.let { item ->
        title = item.text("title") ?: ""
        if (item.text("class")?.contains("bluetooth") == true) kind = "bluetooth"
    }
    if (!activeUri.isNullOrEmpty() && uri == activeUri) return SourceInfo("phone", "Phone audio")
    if (isHousecastStream(uri, metadata, localAddress))
        return SourceInfo("phone-ended", "Previous Housecast stream · start a new stream")
    if (kind == "bluetooth" || uri.contains("bluetooth", ignoreCase = true)) return SourceInfo("bluetooth", "Bluetooth")
    if (uri.startsWith("x-sonos-htastream:")) return SourceInfo("tv", "TV / HDMI")
    if (uri.startsWith("x-rincon-stream:")) return SourceInfo("linein", "Line-in")
    if (uri.startsWith("x-rincon:")) return SourceInfo("group", "Grouped audio")
    if (uri.isEmpty()) return SourceInfo("idle", "No source selected")
    return SourceInfo(kind, title.ifEmpty { "Network audio" })
}

private val IPV4 = Regex("^(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})$")

/** Parses a dotted IPv4 address, or null when it is not one. */
fun ipToLong(ip: String): Long? {
    val match = IPV4.matchEntire(ip) ?: return null
    var value = 0L
    for (i in 1..4) {
        val octet = match.groupValues[i].toInt()
        if (octet > 255) return null
        value = (value shl 8) or octet.toLong()
    }
    return value
}

fun longToIp(value: Long): String = listOf(24, 16, 8, 0).joinToString(".") { ((value shr it) and 255).toString() }

fun isPrivate(ip: String): Boolean {
    val n = ipToLong(ip) ?: return false
    val a = (n shr 24).toInt()
    val b = ((n shr 16) and 255).toInt()
    return a == 10 || (a == 192 && b == 168) || (a == 172 && b in 16..31)
}

fun sameSubnet(a: String, b: String, mask: String): Boolean {
    val x = ipToLong(a) ?: return false
    val y = ipToLong(b) ?: return false
    val m = ipToLong(mask) ?: return false
    return (x and m) == (y and m)
}

fun streamMetadata(url: String, format: String): String {
    val mime = if (format == FORMAT_FLAC) "audio/flac" else "audio/wav"
    return "<DIDL-Lite xmlns:dc=\"http://purl.org/dc/elements/1.1/\" " +
        "xmlns:upnp=\"urn:schemas-upnp-org:metadata-1-0/upnp/\" " +
        "xmlns=\"urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/\">" +
        "<item id=\"$STREAM_ITEM_ID\" parentID=\"0\" restricted=\"true\">" +
        "<dc:title>Phone audio · Housecast</dc:title>" +
        "<upnp:class>object.item.audioItem.audioBroadcast</upnp:class>" +
        "<res protocolInfo=\"http-get:*:$mime:*\">${escapeXml(url)}</res></item></DIDL-Lite>"
}

const val FORMAT_FLAC = "flac16"
const val FORMAT_PCM = "pcm16"
