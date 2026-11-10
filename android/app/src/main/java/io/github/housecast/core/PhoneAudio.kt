package io.github.housecast.core

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.io.IOException
import java.io.OutputStream
import java.net.Socket
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

const val WAV_DATA_SIZE = 0x7ffff000L

fun wavHeader(): ByteArray {
    val b = java.nio.ByteBuffer.allocate(44).order(java.nio.ByteOrder.LITTLE_ENDIAN)
    b.put("RIFF".toByteArray(Charsets.US_ASCII))
    b.putInt((WAV_DATA_SIZE + 36).toInt())
    b.put("WAVEfmt ".toByteArray(Charsets.US_ASCII))
    b.putInt(16)
    b.putShort(1) // PCM
    b.putShort(2) // channels
    b.putInt(SAMPLE_RATE)
    b.putInt(SAMPLE_RATE * 4)
    b.putShort(4)
    b.putShort(16)
    b.put("data".toByteArray(Charsets.US_ASCII))
    b.putInt(WAV_DATA_SIZE.toInt())
    return b.array()
}

class StreamSession(val id: String, val format: String, val targets: List<String>, val url: String, val path: String) {
    @Volatile var phase = "capturing"
    val frames = AtomicLong()
    val bytesSent = AtomicLong()
    val startedAt = System.currentTimeMillis()
    @Volatile var lastPacket = startedAt
    @Volatile var lastSignalAt = 0L
    @Volatile var level = 0f
    @Volatile var disconnectedAt = 0L
    @Volatile var lastEmit = 0L
    val limitReached = AtomicBoolean()
    var before: Snapshot? = null
    var coordinator: String? = null
    var changed = false
}

private class StreamClient(val socket: Socket, val peer: String, val chunked: Boolean) {
    val queue = LinkedBlockingQueue<ByteArray>()
    val queued = AtomicInteger()
    val closed = AtomicBoolean()
    var encoder: FlacEncoder? = null
}

/**
 * Serves the phone's captured audio to the speakers over HTTP and moves the
 * selected rooms onto that stream. [push] is called from the capture thread,
 * [handle] from HTTP server threads; everything else runs on the controller thread.
 */
class PhoneAudio(private val controller: Controller) {
    @Volatile var session: StreamSession? = null
        private set
    @Volatile var lastError: String? = null

    /** Called (on the controller thread) whenever a session has ended for any reason. */
    var onSessionEnded: (() -> Unit)? = null

    private val clients = CopyOnWriteArrayList<StreamClient>()
    private var stopping: Deferred<Boolean>? = null
    private var watchdog: Job? = null

    init {
        controller.audio = this
    }

    fun snapshot(): AudioState {
        val s = session ?: return AudioState(error = lastError)
        return AudioState(
            active = true,
            format = s.format,
            phase = s.phase,
            targets = s.targets,
            clients = clients.size,
            seconds = s.frames.get().toDouble() / SAMPLE_RATE,
            bytesSent = s.bytesSent.get(),
            level = s.level,
            error = lastError,
            health = health(s),
        )
    }

    private fun health(s: StreamSession): Health {
        if (s.phase != "streaming")
            return Health(
                s.phase,
                when (s.phase) {
                    "capturing" -> "Opening Android audio capture…"
                    "connecting" -> "Waiting for speaker playback…"
                    else -> "Stopping phone audio…"
                },
            )
        val time = System.currentTimeMillis()
        val rooms = s.targets.map { controller.rooms[it] }
        val coordinator = controller.rooms[s.coordinator]
        if (time - s.lastPacket > 1500)
            return Health("capture-stalled", "Android audio capture is not sending samples.")
        if (clients.isEmpty() || coordinator?.online != true)
            return Health("disconnected", "The speaker audio connection is interrupted.")
        if (coordinator.state != "PLAYING")
            return Health("not-playing", "The speaker has stopped playing. Restart streaming to resume.")
        if (rooms.all { it == null || it.mute || it.volume == 0 })
            return Health("muted", "The selected rooms are muted or at zero volume.")
        if (time - (if (s.lastSignalAt > 0) s.lastSignalAt else s.startedAt) > 3000)
            return Health(
                "silent",
                "No sound is arriving from Android. Play something, or check Capture check: the playing app may block capture.",
            )
        return Health("receiving", "Phone audio detected · speaker receiving stream")
    }

    fun prepare(ids: List<String>, format: String): StreamSession {
        if (session != null || stopping != null) throw IOException("Phone audio is already running or still stopping.")
        if (format != FORMAT_PCM && format != FORMAT_FLAC) throw IOException("Unknown audio format.")
        if (ids.isEmpty() || ids.size > 16 || ids.toSet().size != ids.size) throw IOException("Select at least one room.")
        if (controller.network == null) throw IOException("Connect to your home Wi-Fi first.")
        ids.forEach { controller.requireRoom(it) }
        lastError = null
        val id = UUID.randomUUID().toString()
        // The path keeps the desktop app's shape so either app recognizes the
        // other's ended streams.
        val path = "/audio/$id/desktop.${if (format == FORMAT_FLAC) "flac" else "wav"}"
        val s = StreamSession(id, format, ids, controller.baseUrl + path, path)
        session = s
        watchdog = controller.scope.launch {
            while (true) {
                delay(2000)
                val time = System.currentTimeMillis()
                if (session !== s) break
                if (s.phase == "streaming" && clients.isEmpty() &&
                    time - (if (s.disconnectedAt > 0) s.disconnectedAt else time) > 6000
                ) {
                    fail("The speaker disconnected. Start streaming again to reconnect.")
                    break
                }
                if (s.phase != "stopping" && time - s.lastPacket > (if (s.frames.get() == 0L) 30000 else 6000)) {
                    fail("Android audio capture stopped responding. Start streaming again to reconnect.")
                    break
                }
            }
        }
        controller.emitState()
        return s
    }

    private fun fail(message: String) {
        lastError = message
        controller.log(message, "error")
        controller.scope.launch { attempt { stop(true) }.onFailure { controller.log(it.message ?: "Stop failed.", "error") } }
    }

    /** Feeds captured 16-bit little-endian stereo PCM. Called from the capture thread. */
    fun push(pcm: ByteArray, length: Int, level: Float) {
        val s = session ?: return
        if (s.phase == "stopping" || length <= 0 || length % 4 != 0) return
        if (s.format == FORMAT_PCM && s.frames.get() * 4 > WAV_DATA_SIZE - 192000) {
            if (s.limitReached.compareAndSet(false, true))
                controller.scope.launch {
                    fail("The PCM session reached its WAV size limit. Restart streaming, or choose FLAC for longer listening.")
                }
            return
        }
        val time = System.currentTimeMillis()
        s.frames.addAndGet(length / 4L)
        s.lastPacket = time
        s.level = level.coerceIn(0f, 1f)
        if (level > 0.00001f) s.lastSignalAt = time
        // A live listener starts with the next capture packet; history is never replayed.
        var copy: ByteArray? = null
        for (client in clients) {
            val encoder = client.encoder
            if (encoder != null) encoder.push(pcm, length)
            else {
                if (copy == null) copy = pcm.copyOf(length)
                write(client, copy)
            }
        }
        if (time - s.lastEmit > 200) {
            s.lastEmit = time
            controller.scope.launch { controller.emitState() }
        }
    }

    private fun write(client: StreamClient, chunk: ByteArray) {
        if (client.closed.get()) return
        if (client.queued.get() > 192000) {
            drop(client, "A speaker stopped reading audio.")
            return
        }
        client.queued.addAndGet(chunk.size)
        client.queue.offer(chunk)
        session?.bytesSent?.addAndGet(chunk.size.toLong())
    }

    private fun drop(client: StreamClient, message: String? = null) {
        if (!client.closed.compareAndSet(false, true)) return
        clients.remove(client)
        client.socket.closeQuietly()
        client.queue.clear()
        session?.disconnectedAt = System.currentTimeMillis()
        controller.scope.launch {
            if (message != null) controller.log(message, "error") else controller.emitState()
        }
    }

    private fun pump(client: StreamClient, out: OutputStream) {
        try {
            while (!client.closed.get()) {
                val chunk = client.queue.poll(500, TimeUnit.MILLISECONDS) ?: continue
                client.queued.addAndGet(-chunk.size)
                if (client.chunked) {
                    val head = (Integer.toHexString(chunk.size) + "\r\n").toByteArray(Charsets.US_ASCII)
                    val framed = ByteArray(head.size + chunk.size + 2)
                    head.copyInto(framed)
                    chunk.copyInto(framed, head.size)
                    framed[framed.size - 2] = '\r'.code.toByte()
                    framed[framed.size - 1] = '\n'.code.toByte()
                    out.write(framed)
                } else out.write(chunk)
            }
        } catch (_: IOException) {
        } catch (_: InterruptedException) {
        } finally {
            drop(client)
        }
    }

    /** Serves `/audio/...` requests. Returns false when the request is not for audio. Runs on a server thread. */
    fun handle(request: HttpRequest, socket: Socket): Boolean {
        if (!request.path.startsWith("/audio/")) return false
        val s = session
        val peer = request.peer
        if (s == null || request.path != s.path || !controller.knownHosts.contains(peer) ||
            (request.method != "GET" && request.method != "HEAD")
        ) {
            socket.respond(404, "Not Found")
            return true
        }
        // Separating a group can make a follower request the coordinator's former
        // stream. Never admit a new reader while stopping: capture has ceased, so
        // that reader would wait forever and block the speaker's next source change.
        if (s.phase == "stopping") {
            socket.respond(410, "Gone")
            return true
        }
        if (clients.size >= 4 && request.method == "GET") {
            socket.respond(503, "Service Unavailable")
            return true
        }
        val flac = s.format == FORMAT_FLAC
        val range = request.headers["range"]
        var offset = 0L
        if (range != null) {
            val start = RANGE.matchEntire(range)?.groupValues?.get(1)?.toLongOrNull()
            if (start == null || (start != 0L && start != 44L) || (flac && start != 0L)) {
                socket.respond(416, "Range Not Satisfiable", mapOf("Accept-Ranges" to "none"))
                return true
            }
            offset = start
        }
        val partial = range != null && !flac
        val chunked = flac && request.version == "HTTP/1.1"
        val head = StringBuilder("HTTP/1.1 ${if (partial) "206 Partial Content" else "200 OK"}\r\n")
        head.append("Content-Type: ${if (flac) "audio/flac" else "audio/wav"}\r\n")
        head.append("Cache-Control: no-store\r\nConnection: close\r\n")
        head.append("transferMode.dlna.org: Streaming\r\n")
        head.append("contentFeatures.dlna.org: DLNA.ORG_OP=00;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000\r\n")
        head.append("Accept-Ranges: none\r\n")
        if (!flac) {
            head.append("Content-Length: ${WAV_DATA_SIZE + 44 - offset}\r\n")
            if (range != null) head.append("Content-Range: bytes $offset-${WAV_DATA_SIZE + 43}/${WAV_DATA_SIZE + 44}\r\n")
        }
        if (chunked) head.append("Transfer-Encoding: chunked\r\n")
        head.append("\r\n")
        try {
            val out = socket.getOutputStream()
            out.write(head.toString().toByteArray(Charsets.ISO_8859_1))
            out.flush()
            if (request.method == "HEAD") {
                socket.closeQuietly()
                return true
            }
            socket.soTimeout = 0
            socket.tcpNoDelay = true
            val client = StreamClient(socket, peer, chunked)
            if (flac) client.encoder = FlacEncoder { write(client, it) }
            else if (offset == 0L) write(client, wavHeader())
            clients.add(client)
            if (session !== s || s.phase == "stopping") {
                drop(client)
                return true
            }
            controller.scope.launch { controller.emitState() }
            pump(client, out)
        } catch (e: IOException) {
            socket.closeQuietly()
        }
        return true
    }

    /** Moves the target rooms onto the stream once capture is delivering audio. */
    suspend fun play(id: String): AudioState {
        val s = session
        if (s == null || s.id != id || s.phase != "capturing") throw IOException("Capture session expired.")
        if (s.frames.get() == 0L) throw IOException("Audio capture has not provided audio yet.")
        s.phase = "connecting"
        controller.emitState()
        fun checkActive() {
            if (session !== s || s.phase == "stopping") throw IOException("Stream was cancelled.")
        }
        try {
            s.before = controller.captureSnapshot()
            checkActive()
            val coordinator = s.targets.firstOrNull {
                isHomeTheater(controller.rooms[it]?.model, controller.devices[it]?.services)
            } ?: s.targets[0]
            s.coordinator = coordinator
            val current = controller.groups.firstOrNull { it.ids.contains(coordinator) }
            if (current != null && (current.coordinator != coordinator || current.ids.any { !s.targets.contains(it) }))
                controller.soap(coordinator, "AVTransport", "BecomeCoordinatorOfStandaloneGroup", mapOf("InstanceID" to 0))
            s.changed = true
            controller.setSource(coordinator, s.url, streamMetadata(s.url, s.format), true)
            checkActive()
            val deadline = System.currentTimeMillis() + 9000
            while (System.currentTimeMillis() < deadline) {
                checkActive()
                controller.refreshRoom(coordinator)
                val room = controller.rooms[coordinator]
                if (clients.isNotEmpty() && s.bytesSent.get() > 4096 && room?.uri == s.url && room.state == "PLAYING") {
                    controller.group(s.targets, coordinator)
                    checkActive()
                    s.phase = "streaming"
                    controller.log("Phone audio is being received by the speakers.")
                    return snapshot()
                }
                delay(200)
            }
            controller.log(
                "Stream check: ${s.frames.get()} captured frames, ${clients.size} connections, " +
                    "${s.bytesSent.get()} bytes sent; speaker ${controller.rooms[coordinator]?.state}.",
                "error",
            )
            throw IOException(
                if (s.bytesSent.get() == 0L)
                    "The speaker cannot connect back to this phone. Check that your router does not isolate Wi-Fi devices (guest networks often do), then retry."
                else "The speaker did not confirm playback. Check its network connection, or try PCM compatibility mode.",
            )
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            lastError = e.message
            attempt { stop(true) }.onFailure {
                controller.log("Could not restore the earlier source: ${it.message}", "error")
            }
            throw e
        }
    }

    /** Ends the session. Returns true when the earlier sources and groups were restored. */
    suspend fun stop(restore: Boolean = true): Boolean {
        stopping?.let { return it.await() }
        val s = session ?: return false
        s.phase = "stopping"
        controller.emitState()
        // Close the live HTTP body first. Some players serialize transport commands
        // behind their decoder's pending network read; pausing the producer alone
        // can make Stop/GetMediaInfo wait indefinitely for more bytes.
        for (client in clients) drop(client)
        val job = controller.scope.async {
            try {
                val before = s.before
                val coordinator = s.coordinator
                if (restore && s.changed && before != null && coordinator != null)
                    controller.restore(before, s.url, coordinator, s.targets)
                else false
            } finally {
                watchdog?.cancel()
                for (client in clients) drop(client)
                session = null
                stopping = null
                controller.emitState()
                onSessionEnded?.invoke()
            }
        }
        stopping = job
        return job.await()
    }

    private companion object {
        val RANGE = Regex("^bytes=(\\d+)-$")
    }
}
