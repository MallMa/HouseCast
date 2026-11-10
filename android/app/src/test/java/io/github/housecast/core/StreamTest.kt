package io.github.housecast.core

import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.net.Inet4Address
import java.net.NetworkInterface
import java.nio.file.Files
import kotlin.concurrent.thread
import kotlin.math.PI
import kotlin.math.sin

/** Runs a whole stream against [TestSpeaker]: discovery by address, play, live audio over HTTP, stop and restore. */
class StreamTest {
    private fun localAddress(): String? = NetworkInterface.getNetworkInterfaces().asSequence()
        .filter { it.isUp }
        .flatMap { it.inetAddresses.asSequence() }
        .filterIsInstance<Inet4Address>()
        .mapNotNull { it.hostAddress }
        .firstOrNull { isPrivate(it) }

    /** 480 frames of a 440 Hz tone, as the capture thread would deliver them. */
    private fun tone(start: Int): ByteArray {
        val out = ByteArray(480 * 4)
        for (i in 0 until 480) {
            val v = (sin(2 * PI * 440 * (start + i) / SAMPLE_RATE) * 12000).toInt()
            for (channel in 0 until 2) {
                out[i * 4 + channel * 2] = v.toByte()
                out[i * 4 + channel * 2 + 1] = (v shr 8).toByte()
            }
        }
        return out
    }

    private fun stream(format: String): TestSpeaker {
        val address = localAddress()
        assumeTrue("needs a private IPv4 address", address != null)
        val speaker = TestSpeaker(address!!)
        val controller = Controller(Files.createTempDirectory("housecast").toFile(), "test") { speaker }
        val audio = PhoneAudio(controller)
        var ended = 0
        audio.onSessionEnded = { ended++ }
        val producing = java.util.concurrent.atomic.AtomicBoolean(true)
        val producer = thread {
            var frame = 0
            while (producing.get()) {
                audio.push(tone(frame), 480 * 4, 0.4f)
                frame += 480
                Thread.sleep(10)
            }
        }
        try {
            runBlocking(controller.dispatcher) {
                controller.start()
                controller.setNetwork(NetworkInfo("test", address, "255.255.255.0"))
                controller.addAddress(address)
                val room = controller.state.value.rooms.single()
                assertTrue(room.online)
                assertEquals("Kitchen", room.name)
                assertEquals(20, room.volume)
                controller.setVolume(room.id, 35)
                assertEquals(35, speaker.volume)

                val session = audio.prepare(listOf(room.id), format)
                while (session.frames.get() == 0L) delay(10)
                controller.run("Start phone audio") { audio.play(session.id) }
                assertEquals("streaming", session.phase)
                assertEquals(session.url, speaker.uri)
                assertTrue(isHousecastStream(speaker.uri, speaker.metadata, address))
                assertEquals("phone", controller.state.value.rooms.single().source.kind)
                delay(600)
                assertEquals("receiving", controller.snapshot().audio.health.code)
                assertTrue(speaker.received.get() > 20000)

                assertTrue(controller.run("Stop phone audio") { audio.stop(true) })
                assertNull(audio.session)
                assertEquals(1, ended)
                // The room is back on what it played before, and playing again.
                assertEquals("x-sonos-spotify:before", speaker.uri)
                assertEquals("PLAYING", speaker.state)
                assertFalse(controller.state.value.audio.active)
                controller.close()
            }
        } finally {
            producing.set(false)
            producer.join()
        }
        return speaker
    }

    @Test
    fun pcmStreamIsServedAsWav() {
        val speaker = stream(FORMAT_PCM)
        assertEquals("audio/wav", speaker.contentType)
        val bytes = synchronized(speaker.audio) { speaker.audio.toByteArray() }
        assertArrayEquals(wavHeader(), bytes.copyOf(44))
        // The body is the pushed tone, untouched.
        assertTrue(bytes.drop(44).any { it.toInt() != 0 })
    }

    @Test
    fun flacStreamIsServedChunked() {
        val speaker = stream(FORMAT_FLAC)
        assertEquals("audio/flac", speaker.contentType)
        val bytes = synchronized(speaker.audio) { speaker.audio.toByteArray() }
        assertArrayEquals(flacHeader(), bytes.copyOf(42))
        val frame = BLOCK_FRAMES * 4 + 10 // frames 0..127 use a one-byte counter
        assertEquals(0xff, bytes[42].toInt() and 0xff)
        assertEquals(0xf8, bytes[43].toInt() and 0xff)
        assertEquals(0xff, bytes[42 + frame].toInt() and 0xff)
        assertEquals(1, bytes[42 + frame + 4].toInt())
        // Kept for decoding with a reference FLAC decoder outside the test run.
        File("build/test-stream.flac").apply { parentFile.mkdirs() }.writeBytes(bytes.copyOf(42 + frame * 40))
    }
}
