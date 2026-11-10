package io.github.housecast

import android.app.Application
import android.content.Context
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import io.github.housecast.core.Controller
import io.github.housecast.core.NetworkInfo
import io.github.housecast.core.PhoneAudio
import io.github.housecast.core.isPrivate
import io.github.housecast.core.longToIp
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import java.net.Inet4Address

/** What the capture service is asked to do once the user has granted capture. */
class CaptureRequest(val test: Boolean, val ids: List<String>, val format: String, val mutePhone: Boolean)

/** Live result of the "does this app let itself be captured" test. */
data class CaptureTestState(
    val running: Boolean = false,
    val level: Float = 0f,
    val elapsedSeconds: Int = 0,
    val signalSeconds: Int = 0,
    val hearingNow: Boolean = false,
)

class HousecastApp : Application() {
    lateinit var controller: Controller
        private set
    lateinit var audio: PhoneAudio
        private set

    /** One-line messages for the UI (errors from commands, permission results). */
    val messages = MutableSharedFlow<String>(extraBufferCapacity = 16)
    val captureTest = MutableStateFlow(CaptureTestState())

    @Volatile
    var pendingCapture: CaptureRequest? = null

    override fun onCreate() {
        super.onCreate()
        controller = Controller(filesDir, BuildConfig.VERSION_NAME)
        audio = PhoneAudio(controller)
        controller.launch { start() }
        NetworkMonitor(this) { info -> controller.launch { setNetwork(info) } }.start()
    }

    /** Runs a controller command and shows its failure, if any, to the user. */
    fun command(block: suspend Controller.() -> Unit): Job =
        controller.launch(onError = { messages.tryEmit(it.message ?: "Something went wrong.") }, block = block)
}

/** Follows the Wi-Fi (or Ethernet) network the speakers live on. */
private class NetworkMonitor(context: Context, private val onChange: (NetworkInfo?) -> Unit) {
    private val manager = context.getSystemService(ConnectivityManager::class.java)
    private val known = LinkedHashMap<Network, NetworkInfo>()

    private val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onLinkPropertiesChanged(network: Network, properties: LinkProperties) {
            val info = describe(network, properties)
            synchronized(known) {
                if (info == null) known.remove(network) else known[network] = info
                publish()
            }
        }

        override fun onLost(network: Network) {
            synchronized(known) {
                known.remove(network)
                publish()
            }
        }
    }

    private fun publish() = onChange(known.values.lastOrNull())

    private fun describe(network: Network, properties: LinkProperties): NetworkInfo? {
        val link = properties.linkAddresses.firstOrNull {
            it.address is Inet4Address && isPrivate(it.address.hostAddress ?: "")
        } ?: return null
        val prefix = link.prefixLength.coerceIn(0, 32)
        val mask = if (prefix == 0) 0L else (0xffffffffL shl (32 - prefix)) and 0xffffffffL
        return NetworkInfo(
            name = properties.interfaceName ?: "Wi-Fi",
            address = link.address.hostAddress ?: return null,
            netmask = longToIp(mask),
            socketFactory = network.socketFactory,
            bindDatagram = { network.bindSocket(it) },
        )
    }

    fun start() {
        for (transport in listOf(NetworkCapabilities.TRANSPORT_WIFI, NetworkCapabilities.TRANSPORT_ETHERNET)) {
            val request = NetworkRequest.Builder()
                .addTransportType(transport)
                .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                .build()
            manager.registerNetworkCallback(request, callback)
        }
    }
}
