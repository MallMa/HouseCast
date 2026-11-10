package io.github.housecast.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.github.housecast.AppCapture
import io.github.housecast.CaptureCheck
import io.github.housecast.CaptureTestState
import io.github.housecast.CaptureVerdict
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

@Composable
fun CaptureCheckScreen(test: CaptureTestState, streaming: Boolean, onStart: () -> Unit, onStop: () -> Unit) {
    val context = LocalContext.current.applicationContext
    var apps by remember { mutableStateOf<List<AppCapture>?>(null) }
    LaunchedEffect(Unit) { apps = withContext(Dispatchers.IO) { CaptureCheck.scan(context) } }

    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item {
            Text(
                "Android only lets Housecast hear apps that allow their sound to be captured. " +
                    "Use the live test for a definite answer, and the list below for a quick overview.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        item { LiveTest(test, streaming, onStart, onStop) }
        item {
            Text("Installed apps", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 8.dp))
            Text(
                "Read from each app's settings. An app marked as allowing capture can still protect " +
                    "individual streams, so confirm with the live test.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        val list = apps
        if (list == null) item { Text("Reading installed apps…", style = MaterialTheme.typography.bodyMedium) }
        else {
            val popular = list.filter { it.popular }
            if (popular.isNotEmpty()) item { AppGroup("Music, video and browsers", popular) }
            val rest = list.filter { !it.popular }
            if (rest.isNotEmpty()) item { AppGroup("Other apps", rest) }
        }
    }
}

@Composable
private fun LiveTest(test: CaptureTestState, streaming: Boolean, onStart: () -> Unit, onStop: () -> Unit) {
    Card(Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainer)) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("Live test", style = MaterialTheme.typography.titleMedium)
            if (test.running) {
                Text(
                    if (test.hearingNow) "Sound is being captured" else "Silence — nothing is being captured",
                    style = MaterialTheme.typography.titleSmall,
                    color = if (test.hearingNow) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error,
                )
                LinearProgressIndicator(
                    progress = { test.level.coerceIn(0f, 1f) },
                    modifier = Modifier.fillMaxWidth().height(8.dp),
                )
                Text(
                    "Captured sound for ${test.signalSeconds} of ${test.elapsedSeconds} seconds.",
                    style = MaterialTheme.typography.bodyMedium,
                )
                Text(
                    "Switch to the app you want to test, play something for a few seconds, then come back. " +
                        "If the seconds with sound went up while it played, that app can be streamed.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                OutlinedButton(onClick = onStop) { Text("Stop test") }
            } else {
                if (test.elapsedSeconds > 0)
                    Text(
                        "Last test: sound for ${test.signalSeconds} of ${test.elapsedSeconds} seconds.",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                Text(
                    "Starts capturing without sending anything to your speakers. Android will ask for " +
                        "permission to record; nothing is saved or sent anywhere.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Button(onClick = onStart, enabled = !streaming) {
                    Text(if (streaming) "Stop streaming to run a test" else "Start live test")
                }
            }
        }
    }
}

@Composable
private fun AppGroup(title: String, apps: List<AppCapture>) {
    Card(Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainer)) {
        Column(Modifier.padding(vertical = 8.dp)) {
            Text(
                title,
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
            )
            apps.forEachIndexed { index, app ->
                if (index > 0) HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        app.label,
                        modifier = Modifier.weight(1f).padding(end = 12.dp),
                        style = MaterialTheme.typography.bodyLarge,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Text(
                        when (app.verdict) {
                            CaptureVerdict.ALLOWED -> "Allows capture"
                            CaptureVerdict.BLOCKED -> "Blocks capture"
                            CaptureVerdict.UNKNOWN -> "Unknown"
                        },
                        style = MaterialTheme.typography.labelLarge,
                        fontWeight = FontWeight.Medium,
                        color = when (app.verdict) {
                            CaptureVerdict.ALLOWED -> MaterialTheme.colorScheme.primary
                            CaptureVerdict.BLOCKED -> MaterialTheme.colorScheme.error
                            CaptureVerdict.UNKNOWN -> MaterialTheme.colorScheme.onSurfaceVariant
                        },
                    )
                }
            }
        }
    }
}
