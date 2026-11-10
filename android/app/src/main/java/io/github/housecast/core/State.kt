package io.github.housecast.core

/** Immutable snapshots published to the UI. */

data class RoomState(
    val id: String,
    val name: String,
    val model: String,
    val soundbar: Boolean,
    val host: String,
    val online: Boolean,
    val checked: Boolean,
    val volume: Int,
    val mute: Boolean,
    val state: String,
    val source: SourceInfo,
    val coordinator: String,
    val groupMembers: List<String>,
    val children: List<String>,
    val error: String?,
)

data class DeviceState(
    val id: String,
    val name: String,
    val model: String,
    val host: String,
    val room: String,
    val hidden: Boolean,
    val role: String,
    val online: Boolean,
    val version: String?,
    val error: String?,
)

data class SearchState(
    val active: Boolean = false,
    val phase: String = "idle",
    val scanned: Int = 0,
    val total: Int = 0,
    val found: Int = 0,
    val note: String = "",
)

data class Health(val code: String, val message: String)

data class AudioState(
    val active: Boolean = false,
    val format: String = "",
    val phase: String = "",
    val targets: List<String> = emptyList(),
    val clients: Int = 0,
    val seconds: Double = 0.0,
    val bytesSent: Long = 0,
    val level: Float = 0f,
    val error: String? = null,
    val health: Health = Health("idle", "Ready to stream"),
)

data class LogEntry(val at: Long, val message: String, val level: String)

data class Operation(val label: String, val state: String, val error: String? = null)

data class AppState(
    val appVersion: String = "",
    val networkName: String? = null,
    val networkAddress: String? = null,
    val discovering: Boolean = false,
    val search: SearchState = SearchState(),
    val autoDiscovery: Boolean = true,
    val devices: List<DeviceState> = emptyList(),
    val rooms: List<RoomState> = emptyList(),
    val busy: Boolean = false,
    val operation: Operation? = null,
    val eventsReceived: Int = 0,
    val logs: List<LogEntry> = emptyList(),
    val audio: AudioState = AudioState(),
)
