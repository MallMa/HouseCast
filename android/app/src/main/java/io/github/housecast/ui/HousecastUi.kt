package io.github.housecast.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.housecast.CaptureRequest
import io.github.housecast.HousecastApp
import io.github.housecast.R

private val DarkColors = darkColorScheme(
    primary = Color(0xFFC4EE9A),
    onPrimary = Color(0xFF16200F),
    primaryContainer = Color(0xFF2F4420),
    onPrimaryContainer = Color(0xFFDDF7C2),
    secondary = Color(0xFFB4CFA0),
    onSecondary = Color(0xFF1C2A14),
    secondaryContainer = Color(0xFF2A3622),
    onSecondaryContainer = Color(0xFFD5EBC2),
    background = Color(0xFF12170F),
    onBackground = Color(0xFFE4EADC),
    surface = Color(0xFF12170F),
    onSurface = Color(0xFFE4EADC),
    surfaceVariant = Color(0xFF242C1E),
    onSurfaceVariant = Color(0xFFB9C2AE),
    surfaceContainer = Color(0xFF1A2114),
    surfaceContainerLow = Color(0xFF171D12),
    surfaceContainerHigh = Color(0xFF222A1C),
    surfaceContainerHighest = Color(0xFF2B3424),
    outline = Color(0xFF7C8672),
    outlineVariant = Color(0xFF3A4432),
    error = Color(0xFFFFB4A9),
    onError = Color(0xFF5A1410),
)

private val LightColors = lightColorScheme(
    primary = Color(0xFF3F6A1F),
    onPrimary = Color.White,
    primaryContainer = Color(0xFFD3F0B4),
    onPrimaryContainer = Color(0xFF12210A),
    secondary = Color(0xFF56624B),
    secondaryContainer = Color(0xFFDFE9D2),
    onSecondaryContainer = Color(0xFF1A2412),
    background = Color(0xFFF8FAF3),
    surface = Color(0xFFF8FAF3),
    surfaceVariant = Color(0xFFE2E7D8),
    surfaceContainer = Color(0xFFEEF2E6),
    surfaceContainerLow = Color(0xFFF2F5EB),
    surfaceContainerHigh = Color(0xFFE8ECDF),
    surfaceContainerHighest = Color(0xFFE2E7D8),
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HousecastUi(app: HousecastApp, onCapture: (CaptureRequest) -> Unit, onStop: () -> Unit) {
    val state by app.controller.state.collectAsStateWithLifecycle()
    val test by app.captureTest.collectAsStateWithLifecycle()
    val snackbar = remember { SnackbarHostState() }
    var tab by rememberSaveable { mutableIntStateOf(0) }
    var selected by rememberSaveable { mutableStateOf(listOf<String>()) }
    var menu by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) { app.messages.collect { snackbar.showSnackbar(it) } }
    // Forget selections for rooms that no longer exist.
    val roomIds = state.rooms.map { it.id }
    val chosen = selected.filter { it in roomIds }

    MaterialTheme(colorScheme = if (isSystemInDarkTheme()) DarkColors else LightColors) {
        Scaffold(
            topBar = {
                TopAppBar(
                    title = { Text(listOf("Housecast", "Capture check", "Settings")[tab]) },
                    actions = {
                        if (tab == 0) {
                            IconButton(onClick = {
                                app.command {
                                    refresh(forceReconnect = true)
                                    discover()
                                }
                            }) { Icon(Icons.Filled.Refresh, contentDescription = "Refresh rooms") }
                            Box {
                            IconButton(onClick = { menu = true }) {
                                Icon(Icons.Filled.MoreVert, contentDescription = "Room actions")
                            }
                            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                                val idle = !state.audio.active && !state.busy
                                DropdownMenuItem(
                                    text = { Text("Group selected rooms") },
                                    enabled = idle && chosen.size > 1,
                                    onClick = {
                                        menu = false
                                        app.command { run("Group selected rooms") { group(chosen) } }
                                    },
                                )
                                DropdownMenuItem(
                                    text = { Text("Separate all rooms") },
                                    enabled = idle,
                                    onClick = {
                                        menu = false
                                        app.command { run("Separate rooms") { separateAll() } }
                                    },
                                )
                                DropdownMenuItem(
                                    text = { Text("Share Bluetooth to selected") },
                                    enabled = idle && chosen.isNotEmpty(),
                                    onClick = {
                                        menu = false
                                        app.command { run("Share Bluetooth") { shareBluetooth(chosen) } }
                                    },
                                )
                            }
                            }
                        }
                    },
                )
            },
            bottomBar = {
                NavigationBar {
                    NavigationBarItem(
                        selected = tab == 0,
                        onClick = { tab = 0 },
                        icon = { Icon(painterResource(R.drawable.ic_speaker), contentDescription = null) },
                        label = { Text("Rooms") },
                    )
                    NavigationBarItem(
                        selected = tab == 1,
                        onClick = { tab = 1 },
                        icon = { Icon(painterResource(R.drawable.ic_equalizer), contentDescription = null) },
                        label = { Text("Capture check") },
                    )
                    NavigationBarItem(
                        selected = tab == 2,
                        onClick = { tab = 2 },
                        icon = { Icon(Icons.Filled.Settings, contentDescription = null) },
                        label = { Text("Settings") },
                    )
                }
            },
            snackbarHost = { SnackbarHost(snackbar) },
        ) { padding ->
            Box(Modifier.fillMaxSize().padding(padding)) {
                when (tab) {
                    0 -> RoomsScreen(
                        app = app,
                        state = state,
                        selected = chosen,
                        testRunning = test.running,
                        onSelect = { id -> selected = if (id in chosen) chosen - id else chosen + id },
                        onStream = { format, mute -> onCapture(CaptureRequest(false, chosen, format, mute)) },
                        onStop = onStop,
                    )
                    1 -> CaptureCheckScreen(
                        test = test,
                        streaming = state.audio.active,
                        onStart = { onCapture(CaptureRequest(true, emptyList(), "", false)) },
                        onStop = onStop,
                    )
                    else -> SettingsScreen(app = app, state = state)
                }
            }
        }
    }
}
