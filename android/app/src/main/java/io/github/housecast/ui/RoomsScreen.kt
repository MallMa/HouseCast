package io.github.housecast.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Slider
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.github.housecast.HousecastApp
import io.github.housecast.R
import io.github.housecast.core.AppState
import io.github.housecast.core.FORMAT_FLAC
import io.github.housecast.core.FORMAT_PCM
import io.github.housecast.core.RoomState
import kotlinx.coroutines.delay
import kotlin.math.roundToInt

@Composable
fun RoomsScreen(
    app: HousecastApp,
    state: AppState,
    selected: List<String>,
    testRunning: Boolean,
    onSelect: (String) -> Unit,
    onStream: (format: String, mutePhone: Boolean) -> Unit,
    onStop: () -> Unit,
) {
    Column(Modifier.fillMaxSize()) {
        LazyColumn(
            modifier = Modifier.weight(1f).fillMaxWidth(),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            if (state.rooms.isEmpty()) item { EmptyRooms(app, state) }
            items(state.rooms, key = { it.id }) { room ->
                RoomCard(
                    room = room,
                    names = state.rooms.associate { it.id to it.name },
                    selected = room.id in selected,
                    selectable = !state.audio.active,
                    streaming = state.audio.active && room.id in state.audio.targets,
                    onSelect = { onSelect(room.id) },
                    onVolume = { app.command { setVolume(room.id, it) } },
                    onMute = { app.command { setMute(room.id, !room.mute) } },
                    onTransport = { action ->
                        app.command {
                            run(if (action == "Play") "Resume playback" else "Pause playback") { transport(room.id, action) }
                        }
                    },
                )
            }
        }
        StreamPanel(state, selected.size, testRunning, onStream, onStop)
    }
}

@Composable
private fun EmptyRooms(app: HousecastApp, state: AppState) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            val searching = state.search.active || state.discovering
            Text(
                when {
                    state.networkAddress == null -> "Not connected to Wi-Fi"
                    searching -> "Looking for speakers…"
                    else -> "No speakers found"
                },
                style = MaterialTheme.typography.titleMedium,
            )
            Text(
                when {
                    state.networkAddress == null ->
                        "Connect this phone to the same Wi-Fi network as your speakers."
                    searching && state.search.total > 0 ->
                        "Checked ${state.search.scanned} of ${state.search.total} addresses."
                    searching -> "This usually takes a few seconds."
                    else -> "Make sure the phone is on the same Wi-Fi as the speakers (not a guest network). " +
                        "You can also add a speaker by its IP address in Settings."
                },
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (state.networkAddress != null && !searching)
                FilledTonalButton(onClick = { app.command { searchDevices(deep = true) } }) { Text("Search again") }
        }
    }
}

@Composable
private fun RoomCard(
    room: RoomState,
    names: Map<String, String>,
    selected: Boolean,
    selectable: Boolean,
    streaming: Boolean,
    onSelect: () -> Unit,
    onVolume: (Int) -> Unit,
    onMute: () -> Unit,
    onTransport: (String) -> Unit,
) {
    val colors = if (streaming || selected)
        CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.secondaryContainer)
    else CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainer)
    Card(modifier = Modifier.fillMaxWidth().alpha(if (room.online) 1f else 0.6f), colors = colors) {
        Column(Modifier.padding(start = 4.dp, end = 12.dp, top = 8.dp, bottom = 8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Checkbox(checked = selected, onCheckedChange = { onSelect() }, enabled = room.online && selectable)
                Column(Modifier.weight(1f)) {
                    Text(room.name, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    val status = when {
                        !room.checked -> "Connecting…"
                        !room.online -> "Offline"
                        streaming -> "Playing this phone"
                        room.state == "PLAYING" -> "Playing · ${room.source.title}"
                        room.state == "TRANSITIONING" -> "Starting · ${room.source.title}"
                        else -> room.source.title
                    }
                    Text(
                        status,
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    val others = room.groupMembers.filter { it != room.id }.mapNotNull { names[it] }
                    val detail = buildList {
                        if (others.isNotEmpty()) add("Grouped with ${others.joinToString(", ")}")
                        if (room.children.isNotEmpty()) add("+ ${room.children.joinToString(", ")}")
                    }.joinToString(" · ")
                    if (detail.isNotEmpty())
                        Text(
                            detail,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                }
                if (room.online && room.source.kind !in listOf("idle", "phone-ended")) {
                    val playing = room.state == "PLAYING" || room.state == "TRANSITIONING"
                    IconButton(onClick = { onTransport(if (playing) "Pause" else "Play") }) {
                        Icon(
                            painterResource(if (playing) R.drawable.ic_pause else R.drawable.ic_play),
                            contentDescription = if (playing) "Pause ${room.name}" else "Play ${room.name}",
                        )
                    }
                }
            }
            if (room.online) {
                // Hold the dragged value until the speaker confirms it, so the
                // thumb does not jump back to the old volume in between.
                var drag by remember(room.id) { mutableStateOf<Float?>(null) }
                var released by remember(room.id) { mutableStateOf(false) }
                LaunchedEffect(room.volume, released) {
                    if (!released) return@LaunchedEffect
                    if (drag?.roundToInt() != room.volume) delay(1500)
                    drag = null
                    released = false
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    IconButton(onClick = onMute) {
                        Icon(
                            painterResource(if (room.mute) R.drawable.ic_volume_off else R.drawable.ic_volume),
                            contentDescription = if (room.mute) "Unmute ${room.name}" else "Mute ${room.name}",
                        )
                    }
                    Slider(
                        value = drag ?: room.volume.toFloat(),
                        onValueChange = {
                            drag = it
                            released = false
                        },
                        onValueChangeFinished = {
                            drag?.let { onVolume(it.roundToInt()) }
                            released = true
                        },
                        valueRange = 0f..100f,
                        modifier = Modifier.weight(1f),
                    )
                    Text(
                        (drag ?: room.volume.toFloat()).roundToInt().toString(),
                        modifier = Modifier.width(36.dp).padding(start = 8.dp),
                        style = MaterialTheme.typography.labelLarge,
                    )
                }
            } else if (room.checked && room.error != null) {
                Text(
                    room.error,
                    modifier = Modifier.padding(start = 12.dp, bottom = 4.dp),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }
        }
    }
}

@Composable
private fun StreamPanel(
    state: AppState,
    selectedCount: Int,
    testRunning: Boolean,
    onStream: (String, Boolean) -> Unit,
    onStop: () -> Unit,
) {
    var format by rememberSaveable { mutableStateOf(FORMAT_FLAC) }
    var mutePhone by rememberSaveable { mutableStateOf(false) }
    val audio = state.audio
    Surface(color = MaterialTheme.colorScheme.surfaceContainerHigh, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(horizontal = 16.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (audio.active) {
                val good = audio.health.code == "receiving"
                Text(
                    audio.health.message,
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.Medium,
                    color = if (good || audio.phase != "streaming") MaterialTheme.colorScheme.onSurface
                    else MaterialTheme.colorScheme.error,
                )
                LinearProgressIndicator(
                    progress = { audio.level.coerceIn(0f, 1f) },
                    modifier = Modifier.fillMaxWidth().height(6.dp),
                )
                val seconds = audio.seconds.toInt()
                Text(
                    "${audio.targets.size} room${if (audio.targets.size == 1) "" else "s"} · " +
                        "${if (audio.format == FORMAT_FLAC) "FLAC" else "PCM"} · " +
                        "%d:%02d".format(seconds / 60, seconds % 60),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Button(onClick = onStop, enabled = audio.phase != "stopping", modifier = Modifier.fillMaxWidth()) {
                    Text("Stop streaming")
                }
            } else {
                audio.error?.let {
                    Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    FilterChip(selected = format == FORMAT_FLAC, onClick = { format = FORMAT_FLAC }, label = { Text("Lossless (FLAC)") })
                    FilterChip(selected = format == FORMAT_PCM, onClick = { format = FORMAT_PCM }, label = { Text("Compatibility (PCM)") })
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("Mute this phone while streaming", style = MaterialTheme.typography.bodyMedium)
                        Text(
                            "Experimental: sets media volume to zero",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    Spacer(Modifier.width(12.dp))
                    Switch(checked = mutePhone, onCheckedChange = { mutePhone = it })
                }
                Button(
                    onClick = { onStream(format, mutePhone) },
                    enabled = selectedCount > 0 && !state.busy && !testRunning && state.networkAddress != null,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(
                        when {
                            testRunning -> "Stop the capture test first"
                            selectedCount == 0 -> "Select rooms to stream to"
                            else -> "Stream phone audio to $selectedCount room${if (selectedCount == 1) "" else "s"}"
                        },
                    )
                }
            }
        }
    }
}
