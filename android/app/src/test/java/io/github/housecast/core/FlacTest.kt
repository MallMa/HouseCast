package io.github.housecast.core

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

class FlacTest {
    @Test
    fun crcsMatchReferenceValues() {
        val check = "123456789".toByteArray()
        assertEquals(0xF4, crc8(check, check.size)) // CRC-8, poly 0x07
        assertEquals(0xFEE8, crc16(check, check.size)) // CRC-16/UMTS, poly 0x8005
    }

    @Test
    fun frameNumbersUseUtf8Coding() {
        assertArrayEquals(byteArrayOf(0x7f), utf8Integer(127))
        assertArrayEquals(byteArrayOf(0xc2.toByte(), 0x80.toByte()), utf8Integer(128))
        assertArrayEquals(byteArrayOf(0xe0.toByte(), 0xa0.toByte(), 0x80.toByte()), utf8Integer(2048))
        assertArrayEquals(byteArrayOf(0xf0.toByte(), 0x90.toByte(), 0x80.toByte(), 0x80.toByte()), utf8Integer(65536))
    }

    @Test
    fun encoderEmitsWholeFramesAndKeepsSamples() {
        val out = ArrayList<ByteArray>()
        val encoder = FlacEncoder(out::add)
        assertEquals(42, out.single().size)
        val pcm = ByteArray(BLOCK_FRAMES * 4 + 8)
        // First frame: left = 0x1234, right = -2 (0xfffe), little-endian.
        pcm[0] = 0x34; pcm[1] = 0x12; pcm[2] = 0xfe.toByte(); pcm[3] = 0xff.toByte()
        encoder.push(pcm, 1000) // partial block: nothing yet
        assertEquals(1, out.size)
        encoder.push(pcm.copyOfRange(1000, pcm.size), pcm.size - 1000)
        assertEquals(2, out.size)
        val frame = out[1]
        assertEquals(BLOCK_FRAMES * 4 + 10, frame.size)
        assertEquals(0x12, frame[7].toInt()); assertEquals(0x34, frame[8].toInt())
        val right = 6 + 1 + BLOCK_FRAMES * 2 + 1
        assertEquals(0xff.toByte(), frame[right]); assertEquals(0xfe.toByte(), frame[right + 1])
        assertEquals(crc16(frame, frame.size - 2), ((frame[frame.size - 2].toInt() and 0xff) shl 8) or (frame[frame.size - 1].toInt() and 0xff))
    }
}
