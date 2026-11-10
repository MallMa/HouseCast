package io.github.housecast

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionConfig
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import io.github.housecast.ui.HousecastUi

class MainActivity : ComponentActivity() {
    private val app get() = application as HousecastApp

    private val permissions = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) askForCapture()
        else {
            app.pendingCapture = null
            app.messages.tryEmit("Android needs the audio recording permission to capture what the phone is playing.")
        }
    }

    private val capture = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val data = result.data
        if (result.resultCode == RESULT_OK && data != null && app.pendingCapture != null) {
            startForegroundService(
                Intent(this, CaptureService::class.java)
                    .setAction(CaptureService.ACTION_START)
                    .putExtra(CaptureService.EXTRA_CODE, result.resultCode)
                    .putExtra(CaptureService.EXTRA_DATA, data),
            )
        } else {
            app.pendingCapture = null
            app.messages.tryEmit("Audio capture was not allowed, so nothing was started.")
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        setContent {
            HousecastUi(app = app, onCapture = ::startCapture, onStop = ::stopCapture)
        }
    }

    override fun onStart() {
        super.onStart()
        app.controller.launch { setUiVisible(true) }
    }

    override fun onStop() {
        app.controller.launch { setUiVisible(false) }
        super.onStop()
    }

    private fun startCapture(request: CaptureRequest) {
        app.pendingCapture = request
        val needed = buildList {
            add(Manifest.permission.RECORD_AUDIO)
            if (Build.VERSION.SDK_INT >= 33) add(Manifest.permission.POST_NOTIFICATIONS)
        }.filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
        if (needed.isEmpty()) askForCapture() else permissions.launch(needed.toTypedArray())
    }

    private fun askForCapture() {
        val manager = getSystemService(MediaProjectionManager::class.java)
        // Whole-device capture: a single-app share would only carry that app's sound.
        val intent = if (Build.VERSION.SDK_INT >= 34)
            manager.createScreenCaptureIntent(MediaProjectionConfig.createConfigForDefaultDisplay())
        else manager.createScreenCaptureIntent()
        capture.launch(intent)
    }

    private fun stopCapture() {
        startService(Intent(this, CaptureService::class.java).setAction(CaptureService.ACTION_STOP))
    }
}
