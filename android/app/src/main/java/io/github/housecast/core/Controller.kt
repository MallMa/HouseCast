package io.github.housecast.core

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.DatagramPacket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.MulticastSocket
import java.net.NetworkInterface
import java.net.SocketTimeoutException
import java.net.URI
import java.util.UUID
import java.util.concurrent.Executors

class Device(val id: String, var host: String) {
    var name = ""
    var model = ""
    var version: String? = null
    var services: Map<String, Service> = emptyMap()
    var hidden = false
    var online = false
    var checked = false
    var lastSeen = 0L
    var roundTrip: Double? = null
    var error: String? = null
}

class Room(val id: String) {
    var name = ""
    var model = ""
    var host = ""
    var online = false
    var checked = false
    var volume = 0
    var mute = false
    var state = "UNKNOWN"

    /** Null until the speaker has reported its source at least once. */
    var uri: String? = null
    var metadata = ""
    var coordinator = id
    var children: List<String> = emptyList()
    var lastSeen = 0L
    var error: String? = null
    var readSequence = 0
}

class SoapResult(val data: Map<String, String>, val ms: Double)

class RoomSnapshot(val id: String, val uri: String, val metadata: String, val state: String)
class Snapshot(val groups: List<Group>, val rooms: List<RoomSnapshot>)

private class Subscription(val host: String, val path: String, val sid: String, val renewedAt: Long)

/** Runs [block], turning any failure except cancellation into a Result. */
internal inline fun <T> attempt(block: () -> T): Result<T> = try {
    Result.success(block())
} catch (e: CancellationException) {
    throw e
} catch (e: Exception) {
    Result.failure(e)
}

/**
 * Discovers speakers on the home network and controls them over their local
 * UPnP interface. All state lives on one thread ([dispatcher]); every method
 * must be called from it (see [launch]).
 */
class Controller(
    private val dataDir: File,
    val appVersion: String,
    private val transportFactory: (NetworkInfo) -> Transport = { OkTransport(it.socketFactory) },
) {
    val dispatcher = Executors.newSingleThreadExecutor { r ->
        Thread(r, "housecast-controller").apply { isDaemon = true }
    }.asCoroutineDispatcher()
    val scope = CoroutineScope(SupervisorJob() + dispatcher)

    val devices = LinkedHashMap<String, Device>()
    val rooms = LinkedHashMap<String, Room>()
    var groups: List<Group> = emptyList()
    var network: NetworkInfo? = null
        private set
    var audio: PhoneAudio? = null
    var busy = false
        private set
    var autoDiscovery = true
        private set

    /** Speaker addresses, readable from the HTTP server threads. */
    @Volatile
    var knownHosts: Set<String> = emptySet()
        private set

    private val _state = MutableStateFlow(AppState(appVersion = appVersion))
    val state: StateFlow<AppState> = _state

    private var transport: Transport? = null
    private var server: MiniServer? = null
    private val eventToken = UUID.randomUUID().toString()
    private val eventPath = Regex("^/events/$eventToken/(RINCON_[A-Z0-9]+)/([A-Za-z]+)$")
    private val subscriptions = HashMap<String, Subscription>()
    private val pendingDevices = HashMap<String, Deferred<Device?>>()
    private val lastDeviceProbe = HashMap<String, Long>()
    private val volumeLocks = HashMap<String, Mutex>()
    private val networkLock = Mutex()
    private var logs = listOf<LogEntry>()
    private var operation: Operation? = null
    private var search = SearchState()
    private var searchJob: Job? = null
    private var searchDeep = false
    private var pendingRefresh: Job? = null
    private var inventoryWork: Job? = null
    private var subscriptionWork: Job? = null
    private var eventRefresh: Job? = null
    private var cacheJob: Job? = null
    private var ticker: Job? = null
    private var discovering = false
    private var closing = false
    private var uiVisible = false
    private var lastRefreshAt = 0L
    private var lastSweep = 0L
    private var lastDiscoveryAt = 0L
    private var lastRenewAt = 0L
    private var eventsReceived = 0
    private var lastBluetooth: RoomSnapshot? = null

    private fun now() = System.currentTimeMillis()

    /** Runs [block] on the controller thread. Failures are reported through [onError]. */
    fun launch(onError: (Exception) -> Unit = {}, block: suspend Controller.() -> Unit): Job = scope.launch {
        try {
            block()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            onError(e)
        }
    }

    fun log(message: String, level: String = "info") {
        logs = (listOf(LogEntry(now(), message, level)) + logs).take(100)
        emitState()
    }

    fun emitState() {
        knownHosts = devices.values.mapTo(HashSet()) { it.host }
        _state.value = snapshot()
    }

    private fun homeTheater(id: String): Boolean = isHomeTheater(rooms[id]?.model ?: devices[id]?.model, devices[id]?.services)

    fun snapshot(): AppState {
        val time = now()
        val activeUrl = audio?.session?.url
        return AppState(
            appVersion = appVersion,
            networkName = network?.name,
            networkAddress = network?.address,
            discovering = discovering,
            search = search,
            autoDiscovery = autoDiscovery,
            devices = devices.values.map { d ->
                val room = rooms[d.id] ?: rooms.values.firstOrNull { it.children.contains(d.id) }
                val ownRoom = if (d.hidden) null else rooms[d.id]
                DeviceState(
                    id = d.id,
                    name = d.name,
                    model = d.model,
                    host = d.host,
                    room = room?.name?.ifEmpty { null } ?: d.name.ifEmpty { "Unassigned" },
                    hidden = d.hidden,
                    role = if (!d.hidden) "Room speaker" else if (d.model.contains("Sub", true)) "Subwoofer" else "Bonded speaker",
                    online = ownRoom?.online ?: (d.online && time - d.lastSeen < 90000),
                    version = d.version,
                    error = ownRoom?.error ?: d.error,
                )
            }.sortedWith(compareBy<DeviceState> { it.room.lowercase() }.thenBy { it.hidden }.thenBy { it.model }),
            rooms = rooms.values.map { r ->
                val coordinator = rooms[r.coordinator] ?: r
                val members = groups.firstOrNull { it.ids.contains(r.id) }?.ids
                RoomState(
                    id = r.id,
                    name = r.name.ifEmpty { "Speaker" },
                    model = r.model,
                    soundbar = homeTheater(r.id),
                    host = r.host,
                    online = r.online,
                    checked = r.checked,
                    volume = r.volume,
                    mute = r.mute,
                    state = coordinator.state,
                    source = sourceInfo(coordinator.uri ?: "", coordinator.metadata, activeUrl, network?.address),
                    coordinator = r.coordinator,
                    groupMembers = members ?: listOf(r.id),
                    children = r.children.map { devices[it]?.model?.ifEmpty { null } ?: "Bonded speaker" },
                    error = r.error,
                )
            }.sortedBy { it.name.lowercase() },
            busy = busy,
            operation = operation,
            eventsReceived = eventsReceived,
            logs = logs.take(40),
            audio = audio?.snapshot() ?: AudioState(),
        )
    }

    /** Loads remembered speakers and starts the periodic upkeep loop. */
    fun start() {
        dataDir.mkdirs()
        attempt {
            val cache = JSONObject(File(dataDir, "rooms.json").readText())
            autoDiscovery = cache.optBoolean("autoDiscovery", true)
            val list = cache.optJSONArray("devices") ?: JSONArray()
            for (i in 0 until list.length()) {
                val d = list.getJSONObject(i)
                val id = d.optString("id")
                val host = d.optString("host")
                if (!id.startsWith("RINCON_") || !isPrivate(host)) continue
                val device = Device(id, host).apply {
                    name = d.optString("name")
                    model = d.optString("model")
                    hidden = d.optBoolean("hidden")
                }
                devices[id] = device
                if (!device.hidden)
                    rooms[id] = Room(id).apply {
                        name = device.name
                        model = device.model
                        this.host = host
                    }
            }
        }
        emitState()
        ticker = scope.launch {
            while (true) {
                delay(1000)
                if (closing || network == null || !(uiVisible || audio?.session != null)) continue
                val time = now()
                if (!busy) {
                    val connected = rooms.isNotEmpty() && rooms.values.all { it.online }
                    // Recover quickly while a known room is offline. Healthy rooms
                    // keep the normal four-second poll; pendingRefresh prevents overlap.
                    if (!connected || time - lastRefreshAt >= 4000) scope.launch { refresh() }
                }
                if (time - lastDiscoveryAt >= 30000) {
                    lastDiscoveryAt = time
                    // Periodically look beyond saved addresses even when all known
                    // rooms are online: multicast may be blocked when a speaker is added.
                    // Never sweep the subnet while audio is streaming.
                    if (autoDiscovery && audio?.session == null)
                        scope.launch { searchDevices(deep = time - lastSweep > 120000) }
                    else scope.launch { refreshInventory() }
                }
                if (time - lastRenewAt >= 40000) {
                    lastRenewAt = time
                    scope.launch { subscribeAll() }
                }
            }
        }
    }

    /** The UI calls this when it becomes visible or hidden, so an idle app does not poll. */
    fun setUiVisible(visible: Boolean) {
        if (uiVisible == visible) return
        uiVisible = visible
        if (visible && network != null && !closing) {
            lastRenewAt = now()
            scope.launch {
                refresh(forceReconnect = true)
                subscribeAll()
            }
        }
    }

    /** Switches to another home network (or none). Restarts the local server and rediscovers. */
    suspend fun setNetwork(info: NetworkInfo?): Unit = networkLock.withLock {
        if (info == null && network == null) return@withLock
        if (info != null && info.sameAs(network)) return@withLock
        audio?.takeIf { it.session != null }?.let {
            it.lastError = "The Wi-Fi connection changed, so streaming stopped."
            attempt { it.stop(restore = false) }
        }
        closing = true
        closeNetworking()
        network = info
        transport = info?.let(transportFactory)
        closing = false
        lastDeviceProbe.clear()
        for (r in rooms.values) {
            r.online = false
            r.checked = false
        }
        if (info == null) {
            log("No home Wi-Fi connection. Connect to the network your speakers are on.", "error")
            return@withLock
        }
        val started = attempt {
            server = MiniServer(InetAddress.getByName(info.address), ::handleHttp)
        }
        if (started.isFailure) log("Could not open a local port for the speakers: ${started.exceptionOrNull()?.message}", "error")
        emitState()
        lastDiscoveryAt = now()
        lastRenewAt = now()
        scope.launch { refresh(forceReconnect = true) }
        scope.launch {
            if (autoDiscovery) searchDevices(deep = devices.isEmpty()) else refreshInventory()
            subscribeAll()
        }
    }

    val baseUrl: String
        get() = "http://${network?.address}:${server?.port}"

    fun allowed(host: String): Boolean {
        val n = network ?: return false
        return sameSubnet(host, n.address, n.netmask)
    }

    // Runs on an HTTP server thread.
    private fun handleHttp(request: HttpRequest, socket: java.net.Socket) {
        if (audio?.handle(request, socket) == true) return
        val match = eventPath.matchEntire(request.path)
        if (request.method != "NOTIFY" || match == null || !knownHosts.contains(request.peer)) {
            socket.respond(404, "Not Found")
            return
        }
        val length = request.headers["content-length"]?.toIntOrNull() ?: 0
        if (length > 1_000_000) {
            socket.closeQuietly()
            return
        }
        var remaining = length
        val buffer = ByteArray(8192)
        while (remaining > 0) {
            val n = request.input.read(buffer, 0, minOf(buffer.size, remaining))
            if (n < 0) break
            remaining -= n
        }
        socket.respond(200, "OK")
        val id = match.groupValues[1]
        scope.launch {
            if (devices[id]?.host != request.peer) return@launch
            eventsReceived++
            eventRefresh?.cancel()
            eventRefresh = scope.launch {
                delay(70)
                refresh()
            }
        }
    }

    private suspend fun request(
        host: String,
        path: String,
        method: String = "GET",
        headers: Map<String, String> = emptyMap(),
        body: String = "",
        timeoutMs: Long = 2000,
    ): HttpResponse {
        val t = transport
        if (t == null || !allowed(host) || !path.startsWith("/") || path.startsWith("//"))
            throw IOException("Speaker address is outside the home network.")
        return t.request(host, path, method, headers, body, timeoutMs)
    }

    suspend fun register(host: String, expectedId: String? = null): Device? {
        if (!allowed(host)) return null
        pendingDevices[host]?.let { return it.await() }
        val job = scope.async(start = CoroutineStart.LAZY) {
            try {
                val response = request(host, "/xml/device_description.xml")
                if (closing) return@async null
                if (response.status != 200) throw IOException("Device description unavailable.")
                val d = describe(response.text, host)
                if (expectedId != null && expectedId != d.id)
                    throw IOException("Address now belongs to a different device. Rediscovering.")
                // A description does not tell us whether a speaker is bonded as a
                // surround. Keep the topology's classification when refreshing.
                val device = devices.getOrPut(d.id) {
                    Device(d.id, host).apply { hidden = !d.services.containsKey("AVTransport") }
                }
                device.host = host
                device.name = d.name
                device.model = d.model
                device.version = d.version
                device.services = d.services
                device.online = true
                device.checked = true
                device.lastSeen = now()
                device.roundTrip = response.ms
                device.error = null
                if (!device.hidden) {
                    val room = rooms.getOrPut(d.id) { Room(d.id) }
                    room.name = d.name
                    room.model = d.model
                    room.host = host
                }
                emitState()
                saveCache()
                device
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (expectedId != null) {
                    devices[expectedId]?.apply {
                        online = false
                        checked = true
                        error = e.message
                    }
                    rooms[expectedId]?.apply {
                        online = false
                        checked = true
                        error = e.message
                    }
                }
                emitState()
                null
            } finally {
                pendingDevices.remove(host)
            }
        }
        pendingDevices[host] = job
        return job.await()
    }

    suspend fun soap(id: String, service: String, action: String, args: Map<String, Any?> = emptyMap()): SoapResult {
        val d = devices[id]
        val s = d?.services?.get(service)
            ?: throw IOException("${d?.name?.ifEmpty { null } ?: "Speaker"} does not expose $service.")
        val response = request(
            d.host,
            s.control,
            method = "POST",
            headers = mapOf("Content-Type" to "text/xml; charset=\"utf-8\"", "SOAPACTION" to "\"${s.type}#$action\""),
            body = envelope(s.type, action, args),
            timeoutMs = if (action.startsWith("Get")) 2000 else 6000,
        )
        val data = soapData(response.text)
        if (response.status != 200) throw IOException("Speaker returned HTTP ${response.status}.")
        return SoapResult(data, response.ms)
    }

    // Blocking multicast search; returns the addresses that answered with a
    // plausible speaker description URL.
    private fun ssdpSearch(net: NetworkInfo): Set<String> {
        val found = LinkedHashSet<String>()
        val local = InetAddress.getByName(net.address)
        MulticastSocket(InetSocketAddress(local, 0)).use { socket ->
            net.bindDatagram(socket)
            socket.timeToLive = 2
            attempt { NetworkInterface.getByInetAddress(local)?.let { socket.networkInterface = it } }
            val message = ("M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\n" +
                "MX: 1\r\nST: urn:schemas-upnp-org:device:ZonePlayer:1\r\n\r\n").toByteArray()
            val target = InetSocketAddress(InetAddress.getByName("239.255.255.250"), 1900)
            socket.send(DatagramPacket(message, message.size, target))
            val deadline = System.nanoTime() + 1_700_000_000L
            var resent = false
            val buffer = ByteArray(4096)
            while (true) {
                val remaining = (deadline - System.nanoTime()) / 1_000_000
                if (remaining <= 0) break
                // UDP is lossy on Wi-Fi: ask once more halfway through.
                if (!resent && remaining < 1100) {
                    resent = true
                    attempt { socket.send(DatagramPacket(message, message.size, target)) }
                }
                socket.soTimeout = minOf(remaining, 300).toInt().coerceAtLeast(1)
                val packet = DatagramPacket(buffer, buffer.size)
                try {
                    socket.receive(packet)
                } catch (e: SocketTimeoutException) {
                    continue
                }
                val peer = packet.address.hostAddress ?: continue
                val text = String(packet.data, 0, packet.length, Charsets.ISO_8859_1)
                val location = LOCATION.find(text)?.groupValues?.get(1)?.trim() ?: continue
                val ok = attempt {
                    val u = URI(location)
                    u.scheme == "http" && u.host == peer && u.port == SPEAKER_PORT
                }.getOrDefault(false)
                if (ok) found.add(peer)
            }
        }
        return found
    }

    suspend fun discover() {
        val net = network ?: return
        if (discovering || closing) return
        discovering = true
        emitState()
        try {
            val hosts = withContext(Dispatchers.IO) { ssdpSearch(net) }
            hosts.filter(::allowed).map { host ->
                scope.async {
                    attempt {
                        val d = register(host)
                        if (d != null && d.services.containsKey("AVTransport") && !d.hidden) refreshRoom(d.id)
                    }
                }
            }.awaitAll()
            refresh()
            scope.launch { subscribeAll() }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (!closing) log("Discovery: ${e.message}", "error")
        } finally {
            discovering = false
            emitState()
        }
    }

    suspend fun refreshInventory() {
        inventoryWork?.let { return it.join() }
        val job = scope.launch(start = CoroutineStart.LAZY) {
            try {
                devices.values.filter { allowed(it.host) }
                    .map { d -> async { register(d.host, d.id) } }
                    .awaitAll()
            } finally {
                inventoryWork = null
                emitState()
            }
        }
        inventoryWork = job
        job.join()
    }

    suspend fun searchDevices(deep: Boolean = true) {
        searchJob?.let {
            val deepInProgress = searchDeep
            it.join()
            if (deep && !deepInProgress && !closing) searchDevices(true)
            return
        }
        val net = network ?: return
        if (closing) return
        val startedAt = now()
        searchDeep = deep
        search = SearchState(active = true, phase = "discovery")
        emitState()
        fun found() = devices.values.count { it.online && it.lastSeen >= startedAt }
        val job = scope.launch(start = CoroutineStart.LAZY) {
            try {
                listOf(async { refreshInventory() }, async { discover() }).awaitAll()
                if (deep) {
                    lastSweep = now()
                    val targets = discoveryTargets(net)
                    val hosts = targets.hosts
                    search = search.copy(phase = "scanning", total = hosts.size, note = targets.note)
                    emitState()
                    var next = 0
                    List(minOf(12, hosts.size)) {
                        async {
                            while (next < hosts.size && !closing) {
                                val host = hosts[next++]
                                if (withContext(Dispatchers.IO) { probePlayerPort(host, net) }) register(host)
                                search = search.copy(scanned = search.scanned + 1, found = found())
                                if (search.scanned % 8 == 0) emitState()
                            }
                        }
                    }.awaitAll()
                }
                if (!closing) {
                    refresh()
                    scope.launch { subscribeAll() }
                }
                search = search.copy(found = found(), phase = "done")
            } catch (e: CancellationException) {
                search = search.copy(phase = "cancelled")
                throw e
            } catch (e: Exception) {
                search = search.copy(phase = "error", note = e.message ?: "")
                log("Speaker search: ${e.message}", "error")
            } finally {
                search = search.copy(active = false)
                searchJob = null
                emitState()
            }
        }
        searchJob = job
        job.join()
    }

    fun setAutoDiscovery(enabled: Boolean) {
        autoDiscovery = enabled
        saveCache()
        emitState()
        if (enabled) scope.launch { searchDevices(deep = devices.isEmpty()) }
    }

    suspend fun refreshTopology(): Topology? {
        val candidates = devices.values
            .filter { it.services.containsKey("ZoneGroupTopology") }
            .sortedWith(
                compareByDescending<Device> { rooms[it.id]?.online == true }
                    .thenByDescending { isHomeTheater(it.model, it.services) },
            )
        var lastError: Exception? = null
        for (d in candidates.take(3)) {
            try {
                val data = soap(d.id, "ZoneGroupTopology", "GetZoneGroupState").data
                val state = topology(data["ZoneGroupState"] ?: "")
                groups = state.groups
                for (m in state.members) {
                    val known = devices[m.id]
                    if (known == null || known.host != m.host)
                        scope.launch {
                            register(m.host, m.id)
                            emitState()
                        }
                    known?.hidden = m.hidden
                    if (m.hidden) {
                        rooms.remove(m.id)
                        continue
                    }
                    val room = rooms.getOrPut(m.id) { Room(m.id).apply { model = known?.model ?: "" } }
                    room.name = m.name
                    room.coordinator = m.coordinator
                    room.children = m.children
                    room.host = if (allowed(m.host)) m.host else known?.host ?: room.host
                }
                saveCache()
                return state
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                lastError = e
            }
        }
        lastError?.let { throw it }
        return null
    }

    suspend fun refreshRoom(id: String) {
        val room = rooms[id] ?: return
        val sequence = ++room.readSequence
        val master = mapOf("InstanceID" to 0, "Channel" to "Master")
        val instance = mapOf("InstanceID" to 0)
        val results = listOf(
            scope.async { attempt { soap(id, "RenderingControl", "GetVolume", master) } },
            scope.async { attempt { soap(id, "RenderingControl", "GetMute", master) } },
            scope.async { attempt { soap(id, "AVTransport", "GetTransportInfo", instance) } },
            scope.async { attempt { soap(id, "AVTransport", "GetMediaInfo", instance) } },
        ).awaitAll()
        val (vol, mute, transport, media) = results
        // A late old read must not overwrite a newer confirmed volume or source.
        if (room.readSequence != sequence) return
        room.checked = true
        room.online = vol.isSuccess && transport.isSuccess
        room.error = if (room.online) null else results.firstOrNull { it.isFailure }?.exceptionOrNull()?.message
        vol.getOrNull()?.let { room.volume = it.data["CurrentVolume"]?.toIntOrNull() ?: room.volume }
        mute.getOrNull()?.let { room.mute = it.data["CurrentMute"] == "1" }
        transport.getOrNull()?.let { room.state = it.data["CurrentTransportState"] ?: "UNKNOWN" }
        media.getOrNull()?.let {
            val uri = it.data["CurrentURI"] ?: ""
            room.uri = uri
            room.metadata = it.data["CurrentURIMetaData"] ?: ""
            if (sourceInfo(uri, room.metadata).kind == "bluetooth")
                lastBluetooth = RoomSnapshot(id, uri, room.metadata, room.state)
        }
        if (room.online) room.lastSeen = now()
        emitState()
    }

    private suspend fun retryKnownDevices(force: Boolean) {
        val time = now()
        devices.values.filter { d ->
            !d.hidden && allowed(d.host) &&
                (force || !d.services.containsKey("AVTransport") || rooms[d.id]?.online != true) &&
                (force || time - (lastDeviceProbe[d.id] ?: 0) >= 1000)
        }.map { d ->
            scope.async {
                attempt {
                    lastDeviceProbe[d.id] = time
                    val device = register(d.host, d.id)
                    // Publish each reachable room immediately, even if another times out.
                    if (!closing && device != null && device.services.containsKey("AVTransport") && !device.hidden)
                        refreshRoom(device.id)
                }
            }
        }.awaitAll()
    }

    suspend fun refresh(forceReconnect: Boolean = false) {
        if (closing) return
        pendingRefresh?.let {
            it.join()
            if (forceReconnect && !closing) refresh(true)
            return
        }
        lastRefreshAt = now()
        val job = scope.launch(start = CoroutineStart.LAZY) {
            try {
                retryKnownDevices(forceReconnect)
                if (closing) return@launch
                attempt { refreshTopology() }
                rooms.keys.toList().map { id -> async { attempt { refreshRoom(id) } } }.awaitAll()
            } finally {
                pendingRefresh = null
                emitState()
            }
        }
        pendingRefresh = job
        job.join()
    }

    private fun saveCache() {
        cacheJob?.cancel()
        cacheJob = scope.launch {
            delay(200)
            val list = JSONArray()
            for (d in devices.values)
                list.put(
                    JSONObject().put("id", d.id).put("host", d.host).put("name", d.name)
                        .put("model", d.model).put("hidden", d.hidden),
                )
            val text = JSONObject().put("autoDiscovery", autoDiscovery).put("devices", list).toString()
            withContext(Dispatchers.IO) { attempt { File(dataDir, "rooms.json").writeText(text) } }
        }
    }

    suspend fun subscribeAll() {
        subscriptionWork?.let { return it.join() }
        val job = scope.launch(start = CoroutineStart.LAZY) {
            try {
                renewSubscriptions()
            } finally {
                subscriptionWork = null
            }
        }
        subscriptionWork = job
        job.join()
    }

    private suspend fun renewSubscriptions() {
        if (closing || server == null) return
        for (d in devices.values.filter { !it.hidden && it.services.containsKey("AVTransport") }) {
            for (service in listOf("ZoneGroupTopology", "AVTransport", "RenderingControl")) {
                val key = "${d.id}/$service"
                val old = subscriptions[key]
                val s = d.services[service] ?: continue
                if (old != null && now() - old.renewedAt < 35000) continue
                try {
                    val headers = if (old != null && old.host == d.host)
                        mapOf("SID" to old.sid, "TIMEOUT" to "Second-120")
                    else mapOf(
                        "CALLBACK" to "<$baseUrl/events/$eventToken/${d.id}/$service>",
                        "NT" to "upnp:event",
                        "TIMEOUT" to "Second-120",
                    )
                    val response = request(d.host, s.event, method = "SUBSCRIBE", headers = headers)
                    val sid = response.headers["sid"]
                    if (response.status != 200 || sid == null) subscriptions.remove(key)
                    else subscriptions[key] = Subscription(d.host, s.event, sid, now())
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    subscriptions.remove(key)
                }
            }
        }
    }

    fun requireRoom(id: String): Room {
        val r = rooms[id]
        if (r == null || !r.online)
            throw IOException("That room is not reachable yet. Refresh the connection and try again.")
        return r
    }

    /** Runs one exclusive source or room change, recording its outcome. */
    suspend fun <T> run(label: String, block: suspend () -> T): T {
        if (busy) throw IOException("A source or room change is already in progress.")
        busy = true
        operation = Operation(label, "working")
        emitState()
        try {
            val result = block()
            operation = Operation(label, "done")
            log(label)
            return result
        } catch (e: CancellationException) {
            operation = Operation(label, "error", "Cancelled")
            throw e
        } catch (e: Exception) {
            operation = Operation(label, "error", e.message)
            log(e.message ?: "$label failed.", "error")
            throw e
        } finally {
            busy = false
            scope.launch { refresh() }
            emitState()
        }
    }

    suspend fun setVolume(id: String, volume: Int) {
        requireRoom(id)
        if (volume !in 0..100) throw IOException("Volume must be from 0 to 100.")
        volumeLocks.getOrPut(id) { Mutex() }.withLock {
            soap(id, "RenderingControl", "SetVolume", mapOf("InstanceID" to 0, "Channel" to "Master", "DesiredVolume" to volume))
            refreshRoom(id)
        }
    }

    suspend fun setMute(id: String, mute: Boolean) {
        requireRoom(id)
        soap(id, "RenderingControl", "SetMute", mapOf("InstanceID" to 0, "Channel" to "Master", "DesiredMute" to if (mute) 1 else 0))
        refreshRoom(id)
    }

    suspend fun transport(id: String, action: String) {
        val r = requireRoom(id)
        if (action !in listOf("Play", "Pause", "Stop")) throw IOException("Unknown playback action.")
        val source = rooms[r.coordinator] ?: r
        if (action == "Play" &&
            isHousecastStream(source.uri ?: "", source.metadata, network?.address) &&
            source.uri != audio?.session?.url
        ) throw IOException("That stream has ended. Use Stream phone audio to start a new one.")
        val args = if (action == "Play") mapOf("InstanceID" to 0, "Speed" to 1) else mapOf("InstanceID" to 0)
        soap(r.coordinator, "AVTransport", action, args)
        refresh()
    }

    private fun sameMembers(group: Group, ids: List<String>) =
        group.ids.size == ids.size && ids.all { group.ids.contains(it) }

    suspend fun group(ids: List<String>, preferredId: String? = null): String {
        if (ids.isEmpty() || ids.size > 16 || ids.toSet().size != ids.size) throw IOException("Select at least one room.")
        ids.forEach { requireRoom(it) }
        refreshTopology()
        val coordinator = if (preferredId != null && ids.contains(preferredId)) preferredId
        else ids.firstOrNull { homeTheater(it) } ?: ids[0]
        val current = groups.firstOrNull { it.ids.contains(coordinator) }
        if (current != null && current.coordinator == coordinator && sameMembers(current, ids)) return coordinator
        if (current != null && (current.coordinator != coordinator || current.ids.any { !ids.contains(it) }))
            soap(coordinator, "AVTransport", "BecomeCoordinatorOfStandaloneGroup", mapOf("InstanceID" to 0))
        if (ids.size > 1 && rooms[coordinator]?.uri == "")
            setSource(coordinator, "x-rincon-queue:$coordinator#0", "", false)
        for (id in ids.filter { it != coordinator })
            soap(
                id, "AVTransport", "SetAVTransportURI",
                mapOf("InstanceID" to 0, "CurrentURI" to "x-rincon:$coordinator", "CurrentURIMetaData" to ""),
            )
        val until = now() + 5000
        do {
            refreshTopology()
            val g = groups.firstOrNull { it.coordinator == coordinator }
            if (g != null && sameMembers(g, ids)) {
                refresh()
                return coordinator
            }
            delay(200)
        } while (now() < until)
        throw IOException("The speakers have not confirmed the requested group. Current room state has been refreshed.")
    }

    /** Makes every online room its own group again. */
    suspend fun separateAll() {
        for (r in rooms.values.filter { it.online }.toList()) group(listOf(r.id))
    }

    suspend fun setSource(id: String, uri: String, metadata: String = "", play: Boolean = true) {
        soap(
            id, "AVTransport", "SetAVTransportURI",
            mapOf("InstanceID" to 0, "CurrentURI" to uri, "CurrentURIMetaData" to metadata),
        )
        if (play) soap(id, "AVTransport", "Play", mapOf("InstanceID" to 0, "Speed" to 1))
        refreshRoom(id)
    }

    suspend fun shareBluetooth(ids: List<String>): List<String> {
        // Any Bluetooth-capable player can be the source. Prefer a room that is
        // playing Bluetooth right now, otherwise the most recently observed session.
        val online = rooms.values.filter { it.online }.toList()
        online.map { r -> scope.async { attempt { refreshRoom(r.id) } } }.awaitAll()
        var source = online.firstOrNull { sourceInfo(it.uri ?: "", it.metadata).kind == "bluetooth" }
        var bt = source?.let { RoomSnapshot(it.id, it.uri ?: "", it.metadata, it.state) }
        if (source == null && lastBluetooth != null) {
            source = online.firstOrNull { it.id == lastBluetooth?.id }
            bt = if (source != null) lastBluetooth else null
        }
        if (source == null || bt == null)
            throw IOException(
                "Connect your phone or other device to a speaker over Bluetooth and start playback. The app can then share that source.",
            )
        val targets = (listOf(source.id) + ids).distinct()
        group(targets, source.id)
        if (source.uri != bt.uri) setSource(source.id, bt.uri, bt.metadata, false)
        refresh()
        if (sourceInfo(source.uri ?: "", source.metadata).kind != "bluetooth")
            throw IOException(
                "The Bluetooth session expired. Reconnect your device to the speaker, start playback, and try sharing again.",
            )
        return targets
    }

    suspend fun captureSnapshot(): Snapshot {
        refreshTopology()
        val saved = groups.toList()
        val instance = mapOf("InstanceID" to 0)
        val list = rooms.values.filter { it.online }.toList().map { r ->
            scope.async {
                val media = soap(r.id, "AVTransport", "GetMediaInfo", instance)
                val transport = soap(r.id, "AVTransport", "GetTransportInfo", instance)
                RoomSnapshot(
                    r.id,
                    media.data["CurrentURI"] ?: "",
                    media.data["CurrentURIMetaData"] ?: "",
                    transport.data["CurrentTransportState"] ?: "STOPPED",
                )
            }
        }
        // Wait for every read before failing, so no request outlives this call.
        val results = list.map { attempt { it.await() } }
        return Snapshot(saved, results.map { it.getOrThrow() })
    }

    /** Puts rooms back on the sources and groups they had before streaming. */
    suspend fun restore(snapshot: Snapshot, ownerUri: String, coordinator: String, targets: List<String>): Boolean {
        val instance = mapOf("InstanceID" to 0)
        val current = soap(coordinator, "AVTransport", "GetMediaInfo", instance)
        if (current.data["CurrentURI"] != ownerUri) return false
        try {
            soap(coordinator, "AVTransport", "Stop", instance)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            val state = soap(coordinator, "AVTransport", "GetTransportInfo", instance)
            if (state.data["CurrentTransportState"] != "STOPPED") throw e
        }
        val affected = LinkedHashSet(targets)
        for (g in snapshot.groups) if (g.ids.any { affected.contains(it) }) affected.addAll(g.ids)
        // Do not change an unrelated room that acquired another source while we streamed.
        for (id in affected) {
            val r = rooms[id]
            if (r?.online != true) return false
            if (!targets.contains(id) && r.uri != snapshot.rooms.firstOrNull { it.id == id }?.uri) return false
        }
        for (id in affected) soap(id, "AVTransport", "BecomeCoordinatorOfStandaloneGroup", instance)
        for (g in snapshot.groups.filter { g -> g.ids.any { affected.contains(it) } }) {
            val original = snapshot.rooms.firstOrNull { it.id == g.coordinator }
            if (original != null && !original.uri.startsWith("x-rincon:")) {
                // A previous Housecast stream has no producer after it is stopped.
                // Restoring its URL makes the speaker wait for a dead HTTP endpoint.
                val expired = isHousecastStream(original.uri, original.metadata, network?.address)
                setSource(
                    g.coordinator,
                    if (expired) "" else original.uri,
                    if (expired) "" else original.metadata,
                    !expired && original.state == "PLAYING",
                )
            }
            for (id in g.ids.filter { it != g.coordinator })
                soap(
                    id, "AVTransport", "SetAVTransportURI",
                    mapOf("InstanceID" to 0, "CurrentURI" to "x-rincon:${g.coordinator}", "CurrentURIMetaData" to ""),
                )
        }
        refresh()
        return true
    }

    suspend fun addAddress(host: String) {
        if (!allowed(host)) throw IOException("Enter a speaker IPv4 address on your home network.")
        register(host) ?: throw IOException("No compatible speaker replied at that address.")
        refresh()
        scope.launch { subscribeAll() }
    }

    /** Forgets every remembered speaker and searches again. */
    suspend fun forgetSpeakers() {
        if (audio?.session != null) throw IOException("Stop streaming before clearing speakers.")
        closeSubscriptions()
        devices.clear()
        rooms.clear()
        groups = emptyList()
        lastBluetooth = null
        saveCache()
        emitState()
        searchDevices(deep = true)
    }

    private suspend fun closeSubscriptions() {
        subscriptionWork?.join()
        for (sub in subscriptions.values.toList())
            withTimeoutOrNull(900) {
                attempt { request(sub.host, sub.path, method = "UNSUBSCRIBE", headers = mapOf("SID" to sub.sid), timeoutMs = 700) }
            }
        subscriptions.clear()
    }

    private suspend fun closeNetworking() {
        searchJob?.cancel()
        searchJob?.join()
        eventRefresh?.cancel()
        closeSubscriptions()
        pendingRefresh?.join()
        server?.close()
        server = null
        transport?.close()
        transport = null
    }

    suspend fun close() {
        closing = true
        ticker?.cancel()
        closeNetworking()
        scope.cancel()
    }

    private companion object {
        val LOCATION = Regex("^location:\\s*(.+)$", setOf(RegexOption.IGNORE_CASE, RegexOption.MULTILINE))
    }
}
