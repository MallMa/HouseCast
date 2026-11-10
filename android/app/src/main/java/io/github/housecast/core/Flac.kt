package io.github.housecast.core

// RFC 9639: fixed 512-sample blocks and two independent verbatim subframes.
// Verbatim coding keeps a steady byte rate even during silence, which avoids
// long byte-based prebuffers in network players. Android playback capture
// delivers 16-bit samples, so the stream is 16-bit / 48 kHz (about 1.5 Mbit/s).
const val BLOCK_FRAMES = 512
const val SAMPLE_RATE = 48000

private val crc8Table = IntArray(256).also { table ->
    for (i in 0 until 256) {
        var a = i
        repeat(8) { a = ((a shl 1) xor (if (a and 0x80 != 0) 0x07 else 0)) and 0xff }
        table[i] = a
    }
}
private val crc16Table = IntArray(256).also { table ->
    for (i in 0 until 256) {
        var b = i shl 8
        repeat(8) { b = ((b shl 1) xor (if (b and 0x8000 != 0) 0x8005 else 0)) and 0xffff }
        table[i] = b
    }
}

internal fun crc8(buffer: ByteArray, length: Int): Int {
    var n = 0
    for (i in 0 until length) n = crc8Table[n xor (buffer[i].toInt() and 0xff)]
    return n
}

internal fun crc16(buffer: ByteArray, length: Int): Int {
    var n = 0
    for (i in 0 until length) n = ((n shl 8) xor crc16Table[(n ushr 8) xor (buffer[i].toInt() and 0xff)]) and 0xffff
    return n
}

/** FLAC's UTF-8-style variable-length frame number. */
internal fun utf8Integer(value: Long): ByteArray {
    if (value < 128) return byteArrayOf(value.toByte())
    var length = 2
    while (value >= (1L shl (5 * length + 1))) length++
    require(length <= 6) { "FLAC frame counter exceeded its range." }
    val bytes = ByteArray(length)
    var rest = value
    for (i in length - 1 downTo 1) {
        bytes[i] = (0x80 or (rest and 63).toInt()).toByte()
        rest = rest shr 6
    }
    bytes[0] = (((0xff shl (8 - length)) and 0xff) or rest.toInt()).toByte()
    return bytes
}

fun flacHeader(): ByteArray {
    val h = ByteArray(42)
    "fLaC".toByteArray(Charsets.US_ASCII).copyInto(h)
    h[4] = 0x80.toByte() // last metadata block, type STREAMINFO
    h[7] = 34
    h[8] = (BLOCK_FRAMES shr 8).toByte(); h[9] = BLOCK_FRAMES.toByte()
    h[10] = (BLOCK_FRAMES shr 8).toByte(); h[11] = BLOCK_FRAMES.toByte()
    // Frame size ranges include the variable-length frame counter.
    val min = BLOCK_FRAMES * 4 + 10
    val max = BLOCK_FRAMES * 4 + 15
    h[12] = (min shr 16).toByte(); h[13] = (min shr 8).toByte(); h[14] = min.toByte()
    h[15] = (max shr 16).toByte(); h[16] = (max shr 8).toByte(); h[17] = max.toByte()
    // 20 bits sample rate, 3 bits channels-1, 5 bits bits-per-sample-1, 36 bits total samples (unknown).
    val packed = (SAMPLE_RATE.toLong() shl 44) or (1L shl 41) or (15L shl 36)
    for (i in 0 until 8) h[18 + i] = (packed shr (56 - 8 * i)).toByte()
    return h
}

/** Encodes one block of 512 interleaved stereo frames (1024 samples). */
fun flacFrame(interleaved: ShortArray, frameNumber: Long): ByteArray {
    require(interleaved.size == BLOCK_FRAMES * 2) { "Invalid FLAC block length." }
    val number = utf8Integer(frameNumber)
    val headerLength = 4 + number.size
    val frame = ByteArray(headerLength + 1 + 2 * (1 + BLOCK_FRAMES * 2) + 2)
    // Sync, fixed block size; 512 samples at 48 kHz; two independent channels, 16 bits.
    frame[0] = 0xff.toByte(); frame[1] = 0xf8.toByte(); frame[2] = 0x9a.toByte(); frame[3] = 0x18
    number.copyInto(frame, 4)
    var offset = headerLength
    frame[offset++] = crc8(frame, headerLength).toByte()
    for (channel in 0 until 2) {
        frame[offset++] = 0x02 // verbatim subframe
        for (i in 0 until BLOCK_FRAMES) {
            val sample = interleaved[i * 2 + channel].toInt()
            frame[offset++] = (sample shr 8).toByte()
            frame[offset++] = sample.toByte()
        }
    }
    val crc = crc16(frame, offset)
    frame[offset++] = (crc shr 8).toByte()
    frame[offset] = crc.toByte()
    return frame
}

/** Turns little-endian 16-bit stereo PCM into a FLAC stream. Not thread-safe. */
class FlacEncoder(private val write: (ByteArray) -> Unit) {
    private val samples = ShortArray(BLOCK_FRAMES * 2)
    private var used = 0
    private var number = 0L

    init {
        write(flacHeader())
    }

    fun push(pcm: ByteArray, length: Int) {
        var offset = 0
        while (offset + 1 < length) {
            samples[used++] = ((pcm[offset].toInt() and 0xff) or (pcm[offset + 1].toInt() shl 8)).toShort()
            offset += 2
            if (used == samples.size) {
                write(flacFrame(samples, number++))
                used = 0
            }
        }
    }
}
