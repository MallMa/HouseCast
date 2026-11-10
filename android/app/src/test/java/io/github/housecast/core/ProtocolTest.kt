package io.github.housecast.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class ProtocolTest {
    @Test
    fun topologyKeepsBondedSpeakersWithTheirRoom() {
        val state = topology(
            """<ZoneGroupState><ZoneGroups>
              <ZoneGroup Coordinator="RINCON_A" ID="RINCON_A:1">
                <ZoneGroupMember UUID="RINCON_A" ZoneName="Living Room" Location="http://192.168.1.10:1400/xml/device_description.xml">
                  <Satellite UUID="RINCON_S" ZoneName="Living Room" Location="http://192.168.1.11:1400/xml/device_description.xml" Invisible="1"/>
                </ZoneGroupMember>
                <ZoneGroupMember UUID="RINCON_B" ZoneName="Kitchen" Location="http://192.168.1.12:1400/xml/device_description.xml"/>
              </ZoneGroup>
              <ZoneGroup Coordinator="RINCON_H" ID="RINCON_H:2">
                <ZoneGroupMember UUID="RINCON_H" ZoneName="Hidden" Invisible="1" Location="http://192.168.1.13:1400/xml/device_description.xml"/>
              </ZoneGroup>
            </ZoneGroups></ZoneGroupState>""",
        )
        assertEquals(listOf(Group("RINCON_A", listOf("RINCON_A", "RINCON_B"))), state.groups)
        assertEquals(listOf("RINCON_A", "RINCON_S", "RINCON_B", "RINCON_H"), state.members.map { it.id })
        val satellite = state.members[1]
        assertTrue(satellite.hidden)
        assertEquals("RINCON_A", satellite.coordinator)
        assertEquals("192.168.1.11", satellite.host)
        assertEquals(listOf("RINCON_S"), state.members[0].children)
    }

    @Test
    fun describeAcceptsOnlyCompatibleSpeakers() {
        val d = describe(TestSpeaker.description("RINCON_X", "Kitchen", "Sonos Arc"), "192.168.1.9")
        assertEquals("RINCON_X", d.id)
        assertEquals("Kitchen", d.name)
        assertEquals("/MediaRenderer/AVTransport/Control", d.services.getValue("AVTransport").control)
        assertTrue(d.services.containsKey("ZoneGroupTopology"))
        assertTrue(isHomeTheater(d.model, d.services))
        assertFalse(isHomeTheater("Sonos One", emptyMap()))
        assertThrows(SpeakerException::class.java) {
            describe("<root><device><manufacturer>Other</manufacturer><UDN>uuid:RINCON_X</UDN></device></root>", "192.168.1.9")
        }
        assertThrows(SpeakerException::class.java) { parseXml("<!DOCTYPE x [<!ENTITY a 'b'>]><x>&a;</x>") }
    }

    @Test
    fun soapResponsesAndFaults() {
        val body = envelope("urn:x:service:AVTransport:1", "Play", mapOf("InstanceID" to 0, "Note" to "a<b&\"c\""))
        assertTrue(body.contains("<Note>a&lt;b&amp;&quot;c&quot;</Note>"))
        val data = soapData(
            "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\"><s:Body>" +
                "<u:GetMediaInfoResponse xmlns:u=\"urn:x\"><CurrentURI>x-rincon:RINCON_A</CurrentURI>" +
                "<CurrentURIMetaData>&lt;DIDL-Lite/&gt;</CurrentURIMetaData></u:GetMediaInfoResponse></s:Body></s:Envelope>",
        )
        assertEquals("x-rincon:RINCON_A", data["CurrentURI"])
        assertEquals("<DIDL-Lite/>", data["CurrentURIMetaData"])
        val fault = assertThrows(SpeakerException::class.java) {
            soapData(
                "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\"><s:Body><s:Fault><detail>" +
                    "<UPnPError xmlns=\"urn:schemas-upnp-org:control-1-0\"><errorCode>701</errorCode></UPnPError>" +
                    "</detail></s:Fault></s:Body></s:Envelope>",
            )
        }
        assertEquals("701", fault.code)
    }

    @Test
    fun sourcesAreRecognized() {
        val uri = "http://192.168.1.2:52677/audio/16c18fe7-b515-4944-a185-7ff3b6fa049e/desktop.flac"
        val metadata = streamMetadata(uri, FORMAT_FLAC)
        assertEquals("phone-ended", sourceInfo(uri, metadata).kind)
        assertEquals("phone", sourceInfo(uri, metadata, uri).kind)
        assertTrue(isHousecastStream(uri, metadata, "192.168.1.2"))
        assertFalse(isHousecastStream(uri, metadata, "192.168.1.3"))
        assertFalse(isHousecastStream(uri, "", null))
        assertFalse(isHousecastStream("http://8.8.8.8:1/audio/16c18fe7-b515-4944-a185-7ff3b6fa049e/desktop.flac", metadata))
        assertEquals("bluetooth", sourceInfo("x-sonos-vli:A:3,bluetooth:session", "").kind)
        assertEquals("tv", sourceInfo("x-sonos-htastream:RINCON_A:spdif", "").kind)
        assertEquals("group", sourceInfo("x-rincon:RINCON_A", "").kind)
        assertEquals("idle", sourceInfo("", "").kind)
        assertEquals("music", sourceInfo("x-sonos-spotify:track", "").kind)
    }

    @Test
    fun addressesAndScanTargets() {
        assertTrue(isPrivate("10.1.2.3"))
        assertTrue(isPrivate("172.31.0.1"))
        assertFalse(isPrivate("172.32.0.1"))
        assertFalse(isPrivate("8.8.8.8"))
        assertFalse(isPrivate("192.168.1.999"))
        assertTrue(sameSubnet("192.168.1.5", "192.168.1.200", "255.255.255.0"))
        assertFalse(sameSubnet("192.168.2.5", "192.168.1.200", "255.255.255.0"))
        val targets = discoveryTargets(NetworkInfo("wlan0", "192.168.1.5", "255.255.255.0"))
        assertEquals(253, targets.hosts.size)
        assertFalse(targets.hosts.contains("192.168.1.5"))
        assertEquals("192.168.1.1", targets.hosts.first())
        assertEquals("192.168.1.254", targets.hosts.last())
        assertTrue(discoveryTargets(NetworkInfo("wlan0", "10.0.0.5", "255.255.0.0")).hosts.isEmpty())
    }
}
