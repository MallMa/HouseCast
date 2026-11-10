package io.github.housecast.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import io.github.housecast.HousecastApp
import io.github.housecast.core.AppState
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@Composable
private fun Section(title: String, content: @Composable () -> Unit) {
    Card(Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainer)) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium)
            content()
        }
    }
}

@Composable
private fun Note(text: String) =
    Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)

@Composable
fun SettingsScreen(app: HousecastApp, state: AppState) {
    var address by rememberSaveable { mutableStateOf("") }
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item {
            Section("Network") {
                Text(
                    state.networkAddress?.let { "Connected · this phone is $it" } ?: "Not connected to a home network",
                    style = MaterialTheme.typography.bodyMedium,
                )
                Note("Speakers must be on the same Wi-Fi network as this phone. Guest networks usually block this.")
            }
        }
        item {
            Section("Find speakers") {
                val search = state.search
                Text(
                    when {
                        search.active && search.phase == "scanning" ->
                            "Scanning addresses: ${search.scanned} of ${search.total}"
                        search.active -> "Searching…"
                        search.phase == "done" -> "Last search found ${search.found} device${if (search.found == 1) "" else "s"}."
                        search.phase == "error" -> "Search failed: ${search.note}"
                        else -> "Speakers are found automatically."
                    },
                    style = MaterialTheme.typography.bodyMedium,
                )
                if (search.note.isNotEmpty() && search.phase != "error") Note(search.note)
                FilledTonalButton(
                    onClick = { app.command { searchDevices(deep = true) } },
                    enabled = !search.active && state.networkAddress != null && !state.audio.active,
                ) { Text("Search now") }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("Search automatically", style = MaterialTheme.typography.bodyMedium)
                        Note("Looks for new speakers while the app is open")
                    }
                    Switch(checked = state.autoDiscovery, onCheckedChange = { on -> app.command { setAutoDiscovery(on) } })
                }
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(
                        value = address,
                        onValueChange = { address = it.trim() },
                        label = { Text("Speaker IP address") },
                        placeholder = { Text("192.168.1.20") },
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                        modifier = Modifier.weight(1f),
                    )
                    FilledTonalButton(
                        onClick = {
                            val host = address
                            app.command {
                                run("Find speaker") { addAddress(host) }
                                address = ""
                            }
                        },
                        enabled = address.isNotEmpty() && !state.busy,
                    ) { Text("Add") }
                }
            }
        }
        item {
            Section("Speakers") {
                if (state.devices.isEmpty()) Note("No speakers remembered yet.")
                for (d in state.devices) {
                    Column {
                        Text(
                            "${d.room} · ${d.model.ifEmpty { "Speaker" }}",
                            style = MaterialTheme.typography.bodyMedium,
                        )
                        Note("${d.role} · ${d.host} · ${if (d.online) "online" else "offline"}" + (d.version?.let { " · v$it" } ?: ""))
                        if (!d.online && d.error != null)
                            Text(d.error, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
                    }
                }
                if (state.devices.isNotEmpty())
                    TextButton(
                        onClick = { app.command { forgetSpeakers() } },
                        enabled = !state.audio.active && !state.busy,
                    ) { Text("Forget all and search again") }
            }
        }
        item {
            Section("Activity") {
                if (state.logs.isEmpty()) Note("Nothing has happened yet.")
                val time = SimpleDateFormat("HH:mm:ss", Locale.US)
                for (entry in state.logs.take(25))
                    Text(
                        "${time.format(Date(entry.at))}  ${entry.message}",
                        style = MaterialTheme.typography.bodySmall,
                        color = if (entry.level == "error") MaterialTheme.colorScheme.error
                        else MaterialTheme.colorScheme.onSurfaceVariant,
                    )
            }
        }
        item {
            Section("About") {
                Text("Housecast for Android ${state.appVersion}", style = MaterialTheme.typography.bodyMedium)
                Note(
                    "Preview build. Free, open source and fully local: no account, no cloud. " +
                        "Audio is never saved and never leaves your home network.",
                )
                Note(
                    "Housecast works with Sonos® speakers using their local network interface. It is an " +
                        "independent project and is not affiliated with, endorsed by or sponsored by Sonos, Inc.",
                )
            }
        }
    }
}
