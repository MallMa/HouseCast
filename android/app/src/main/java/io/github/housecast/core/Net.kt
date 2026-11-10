package io.github.housecast.core

import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Callback
import okhttp3.ConnectionPool
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketException
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import javax.net.SocketFactory
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

const val SPEAKER_PORT = 1400

/**
 * The home network the app talks on. On Android the socket factory and the
 * datagram hook pin traffic to the Wi-Fi network even when mobile data is the
 * system default route.
 */
class NetworkInfo(
    val name: String,
    val address: String,
    val netmask: String,
    val socketFactory: SocketFactory = SocketFactory.getDefault(),
    val bindDatagram: (DatagramSocket) -> Unit = {},
) {
    fun sameAs(other: NetworkInfo?) =
        other != null && other.address == address && other.netmask == netmask && other.name == name
}

class HttpResponse(val status: Int, val headers: Map<String, String>, val text: String, val ms: Double)

/** HTTP to a speaker's control port. Abstracted so the controller can be unit-tested. */
interface Transport {
    suspend fun request(
        host: String,
        path: String,
        method: String = "GET",
        headers: Map<String, String> = emptyMap(),
        body: String = "",
        timeoutMs: Long = 2000,
    ): HttpResponse

    fun close() {}
}

class OkTransport(socketFactory: SocketFactory) : Transport {
    private val client = OkHttpClient.Builder()
        .socketFactory(socketFactory)
        .connectionPool(ConnectionPool(8, 30, TimeUnit.SECONDS))
        .retryOnConnectionFailure(true)
        .followRedirects(false)
        .build()

    override suspend fun request(
        host: String,
        path: String,
        method: String,
        headers: Map<String, String>,
        body: String,
        timeoutMs: Long,
    ): HttpResponse {
        val builder = Request.Builder().url("http://$host:$SPEAKER_PORT$path")
        for ((k, v) in headers) builder.header(k, v)
        builder.method(method, if (method == "POST") body.toByteArray().toRequestBody(null) else null)
        val call = client.newCall(builder.build())
        call.timeout().timeout(timeoutMs, TimeUnit.MILLISECONDS)
        val started = System.nanoTime()
        return suspendCancellableCoroutine { continuation ->
            continuation.invokeOnCancellation { call.cancel() }
            call.enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) {
                    val message = if (e is java.io.InterruptedIOException || e.message == "timeout")
                        "No reply from $host within $timeoutMs ms." else (e.message ?: "Speaker connection failed.")
                    continuation.resumeWithException(IOException(message, e))
                }

                override fun onResponse(call: Call, response: Response) {
                    try {
                        val text = response.use {
                            val source = it.body!!.source()
                            source.request(2_000_001)
                            if (source.buffer.size > 2_000_000) throw IOException("Speaker response was too large.")
                            source.buffer.readUtf8()
                        }
                        val map = HashMap<String, String>()
                        for ((name, value) in response.headers) map[name.lowercase()] = value
                        continuation.resume(
                            HttpResponse(response.code, map, text, (System.nanoTime() - started) / 1e6),
                        )
                    } catch (e: IOException) {
                        continuation.resumeWithException(e)
                    }
                }
            })
        }
    }

    override fun close() {
        client.dispatcher.cancelAll()
        client.connectionPool.evictAll()
    }
}

class HttpRequest(
    val method: String,
    val path: String,
    val version: String,
    val headers: Map<String, String>,
    val peer: String,
    val input: InputStream,
)

/**
 * A very small HTTP/1.1 server: speakers use it to deliver UPnP events
 * (NOTIFY) and to pull the live audio stream. Each connection serves one
 * request; the handler owns the socket and must write a complete response.
 */
class MiniServer(bind: InetAddress, private val handler: (HttpRequest, Socket) -> Unit) {
    private val server = ServerSocket().apply {
        reuseAddress = true
        bind(InetSocketAddress(bind, 0), 16)
    }
    private val pool: ExecutorService = Executors.newCachedThreadPool { r ->
        Thread(r, "housecast-http").apply { isDaemon = true }
    }
    val port: Int get() = server.localPort

    init {
        Thread({
            while (!server.isClosed) {
                val socket = try {
                    server.accept()
                } catch (e: IOException) {
                    break
                }
                try {
                    pool.execute { serve(socket) }
                } catch (e: Exception) {
                    socket.closeQuietly()
                }
            }
        }, "housecast-accept").apply { isDaemon = true }.start()
    }

    private fun serve(socket: Socket) {
        try {
            socket.soTimeout = 5000
            socket.tcpNoDelay = true
            val input = socket.getInputStream()
            val head = readHead(input) ?: return socket.closeQuietly()
            val lines = head.split("\r\n")
            val request = lines[0].split(" ")
            if (request.size != 3) return socket.closeQuietly()
            val headers = HashMap<String, String>()
            for (line in lines.drop(1)) {
                val colon = line.indexOf(':')
                if (colon > 0) headers[line.substring(0, colon).trim().lowercase()] = line.substring(colon + 1).trim()
            }
            val peer = (socket.remoteSocketAddress as InetSocketAddress).address.hostAddress ?: ""
            handler(HttpRequest(request[0], request[1], request[2], headers, peer, input), socket)
        } catch (e: Exception) {
            socket.closeQuietly()
        }
    }

    private fun readHead(input: InputStream): String? {
        val out = ByteArrayOutputStream(512)
        var matched = 0
        while (out.size() < 16384) {
            val b = input.read()
            if (b < 0) return null
            out.write(b)
            matched = when {
                b == '\r'.code && (matched == 0 || matched == 2) -> matched + 1
                b == '\n'.code && (matched == 1 || matched == 3) -> matched + 1
                b == '\r'.code -> 1
                else -> 0
            }
            if (matched == 4) return String(out.toByteArray(), 0, out.size() - 4, Charsets.ISO_8859_1)
        }
        return null
    }

    fun close() {
        try {
            server.close()
        } catch (_: IOException) {
        }
        pool.shutdownNow()
    }
}

fun Socket.closeQuietly() {
    try {
        close()
    } catch (_: IOException) {
    }
}

/** Writes a short, complete response and closes the connection. */
fun Socket.respond(status: Int, reason: String, headers: Map<String, String> = emptyMap()) {
    try {
        val text = StringBuilder("HTTP/1.1 $status $reason\r\n")
        for ((k, v) in headers) text.append("$k: $v\r\n")
        if (!headers.containsKey("Content-Length")) text.append("Content-Length: 0\r\n")
        text.append("Connection: close\r\n\r\n")
        val out: OutputStream = getOutputStream()
        out.write(text.toString().toByteArray(Charsets.ISO_8859_1))
        out.flush()
    } catch (_: IOException) {
    } finally {
        closeQuietly()
    }
}

/** Addresses worth probing when multicast discovery is blocked. */
class ScanTargets(val hosts: List<String>, val note: String)

fun discoveryTargets(network: NetworkInfo?): ScanTargets {
    val address = network?.let { ipToLong(it.address) }
    val mask = network?.let { ipToLong(it.netmask) }
    if (network == null || address == null || mask == null || !isPrivate(network.address))
        return ScanTargets(emptyList(), "Connect to your home Wi-Fi to search.")
    val inverse = mask.inv() and 0xffffffffL
    if ((inverse and (inverse + 1)) != 0L || inverse > 511)
        return ScanTargets(
            emptyList(),
            "This network is too large for an address scan. Multicast discovery and saved addresses are still checked.",
        )
    val base = address and mask
    val hosts = ArrayList<String>()
    for (i in 1 until inverse) {
        val host = longToIp(base + i)
        if (host != network.address) hosts.add(host)
    }
    return ScanTargets(hosts, "")
}

/** True when something accepts TCP connections on the speaker control port. Blocking. */
fun probePlayerPort(host: String, network: NetworkInfo): Boolean {
    val socket = try {
        network.socketFactory.createSocket()
    } catch (e: IOException) {
        return false
    }
    return try {
        socket.connect(InetSocketAddress(host, SPEAKER_PORT), 450)
        true
    } catch (e: IOException) {
        false
    } catch (e: SocketException) {
        false
    } finally {
        socket.closeQuietly()
    }
}
