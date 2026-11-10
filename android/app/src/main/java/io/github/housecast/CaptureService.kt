package io.github.housecast

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioPlaybackCaptureConfiguration
import android.media.AudioRecord
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.net.wifi.WifiManager
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import io.github.housecast.core.SAMPLE_RATE
import kotlinx.coroutines.delay
import java.io.IOException
import kotlin.math.abs

/**
 * Foreground service that owns the playback capture. It either feeds a live
 * stream to the speakers, or (test mode) only measures whether sound arrives,
 * which shows whether the playing app allows its audio to be captured.
 */
class CaptureService : Service() {
    private val app get() = application as HousecastApp
    private val main = Handler(Looper.getMainLooper())
    private var projection: MediaProjection? = null
    private var record: AudioRecord? = null
    private var thread: Thread? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null
    private var savedVolume = -1
    private var test = false
    private var closed = false

    @Volatile
    private var running = false

    private val projectionCallback = object : MediaProjection.Callback() {
        override fun onStop() = requestStop()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> requestStop()
            ACTION_START -> if (!running) begin(intent)
            else -> if (!running) stopSelf()
        }
        return START_NOT_STICKY
    }

    private fun begin(intent: Intent) {
        val request = app.pendingCapture
        app.pendingCapture = null
        val data: Intent? = intent.getParcelableExtra(EXTRA_DATA)
        test = request?.test ?: true
        try {
            startForeground(NOTIFICATION_ID, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
            if (request == null || data == null) throw IOException("Capture permission was not granted.")
            if (checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) != android.content.pm.PackageManager.PERMISSION_GRANTED)
                throw SecurityException()
            val manager = getSystemService(MediaProjectionManager::class.java)
            val granted = manager.getMediaProjection(intent.getIntExtra(EXTRA_CODE, 0), data)
                ?: throw IOException("Android did not grant audio capture.")
            projection = granted
            granted.registerCallback(projectionCallback, main)
            val config = AudioPlaybackCaptureConfiguration.Builder(granted)
                .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
                .addMatchingUsage(AudioAttributes.USAGE_GAME)
                .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
                .build()
            val format = AudioFormat.Builder()
                .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                .setSampleRate(SAMPLE_RATE)
                .setChannelMask(AudioFormat.CHANNEL_IN_STEREO)
                .build()
            val minimum = AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_STEREO, AudioFormat.ENCODING_PCM_16BIT)
            val recorder = AudioRecord.Builder()
                .setAudioFormat(format)
                .setBufferSizeInBytes(maxOf(minimum * 4, SAMPLE_RATE * 4 / 4))
                .setAudioPlaybackCaptureConfig(config)
                .build()
            record = recorder
            if (recorder.state != AudioRecord.STATE_INITIALIZED) throw IOException("Android audio capture could not be opened.")
            recorder.startRecording()
        } catch (e: Exception) {
            val message = when (e) {
                is SecurityException -> "Android refused audio capture. Allow the microphone permission and try again."
                else -> e.message ?: "Audio capture could not start."
            }
            app.messages.tryEmit(message)
            shutdown()
            return
        }
        running = true
        acquireLocks()
        if (!test && request!!.mutePhone) mutePhone()
        thread = Thread({ captureLoop() }, "housecast-capture").apply {
            priority = Thread.MAX_PRIORITY
            start()
        }
        if (test) app.captureTest.value = CaptureTestState(running = true)
        else startStream(request!!)
    }

    private fun startStream(request: CaptureRequest) {
        val audio = app.audio
        app.controller.launch(onError = {
            app.messages.tryEmit(it.message ?: "Streaming could not start.")
            // A failed play() has already ended its session; anything left over
            // (for example capture that never delivered audio) is ended here.
            main.post { requestStop() }
        }) {
            val session = audio.prepare(request.ids, request.format)
            audio.onSessionEnded = { main.post { shutdown() } }
            var waited = 0
            while (session.frames.get() == 0L && waited < 10000) {
                delay(50)
                waited += 50
            }
            if (audio.session === session) run("Start phone audio") { audio.play(session.id) }
        }
    }

    private fun captureLoop() {
        android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_AUDIO)
        val recorder = record ?: return
        val audio = app.audio
        val buffer = ByteArray(3840) // 20 ms of 48 kHz stereo 16-bit
        var frames = 0L
        var signalFrames = 0L
        var lastSignalFrame = -1L
        var lastReport = 0L
        var peakSinceReport = 0f
        while (running) {
            val read = recorder.read(buffer, 0, buffer.size)
            if (read < 0) break
            val length = read - read % 4
            if (length == 0) continue
            var peak = 0
            var i = 0
            while (i < length) {
                val sample = abs((buffer[i].toInt() and 0xff) or (buffer[i + 1].toInt() shl 8))
                if (sample > peak) peak = sample
                i += 2
            }
            val level = peak / 32768f
            if (test) {
                frames += length / 4
                if (peak > 0) {
                    signalFrames += length / 4
                    lastSignalFrame = frames
                }
                if (level > peakSinceReport) peakSinceReport = level
                if (frames - lastReport >= SAMPLE_RATE / 10) {
                    lastReport = frames
                    app.captureTest.value = CaptureTestState(
                        running = true,
                        level = peakSinceReport,
                        elapsedSeconds = (frames / SAMPLE_RATE).toInt(),
                        signalSeconds = (signalFrames / SAMPLE_RATE).toInt(),
                        hearingNow = lastSignalFrame >= 0 && frames - lastSignalFrame < SAMPLE_RATE,
                    )
                    peakSinceReport = 0f
                }
                // A forgotten test should not hold the capture forever.
                if (frames > SAMPLE_RATE * 600L) main.post { requestStop() }
            } else audio.push(buffer, length, level)
        }
        if (running) main.post { requestStop() }
    }

    /** Ends the stream cleanly (restoring the rooms) and then the service. */
    private fun requestStop() {
        val audio = app.audio
        if (test || audio.session == null) {
            shutdown()
            return
        }
        app.controller.launch(onError = {
            app.messages.tryEmit(it.message ?: "Stopping failed.")
            if (audio.session == null) main.post { shutdown() }
        }) {
            // onSessionEnded shuts the service down once the rooms are restored.
            if (busy) audio.stop(true) else run("Stop phone audio") { audio.stop(true) }
        }
    }

    private fun shutdown() {
        if (closed) return
        closed = true
        running = false
        app.audio.onSessionEnded = null
        // If the service dies with a session still open (system kill), end it.
        if (app.audio.session != null) app.command { audio?.stop(true) }
        thread?.let {
            it.interrupt()
            try {
                it.join(500)
            } catch (_: InterruptedException) {
            }
        }
        record?.let {
            try {
                it.stop()
            } catch (_: IllegalStateException) {
            }
            it.release()
        }
        record = null
        projection?.let {
            it.unregisterCallback(projectionCallback)
            it.stop()
        }
        projection = null
        if (savedVolume >= 0) {
            val manager = getSystemService(AudioManager::class.java)
            // Leave the volume alone if the user changed it while streaming.
            if (manager.getStreamVolume(AudioManager.STREAM_MUSIC) == 0)
                try {
                    manager.setStreamVolume(AudioManager.STREAM_MUSIC, savedVolume, 0)
                } catch (_: SecurityException) {
                }
            savedVolume = -1
        }
        wakeLock?.takeIf { it.isHeld }?.release()
        wifiLock?.takeIf { it.isHeld }?.release()
        if (test) app.captureTest.value = app.captureTest.value.copy(running = false, level = 0f, hearingNow = false)
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        shutdown()
        super.onDestroy()
    }

    private fun mutePhone() {
        val manager = getSystemService(AudioManager::class.java)
        try {
            savedVolume = manager.getStreamVolume(AudioManager.STREAM_MUSIC)
            manager.setStreamVolume(AudioManager.STREAM_MUSIC, 0, 0)
        } catch (_: SecurityException) {
            savedVolume = -1 // Do Not Disturb can forbid volume changes.
        }
    }

    private fun acquireLocks() {
        wakeLock = getSystemService(PowerManager::class.java)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "housecast:capture")
            .apply { acquire(12 * 60 * 60 * 1000L) }
        @Suppress("DEPRECATION")
        wifiLock = (applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager)
            .createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "housecast:capture")
            .apply { acquire() }
    }

    private fun notification(): Notification {
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL, "Streaming", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Shown while phone audio is being captured"
            },
        )
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE,
        )
        val stop = PendingIntent.getService(
            this, 1, Intent(this, CaptureService::class.java).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE,
        )
        return Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_housecast)
            .setContentTitle(if (test) "Testing audio capture" else "Streaming phone audio")
            .setContentText(if (test) "Play something, then return to Housecast" else "Your speakers are playing this phone's sound")
            .setContentIntent(open)
            .setOngoing(true)
            .addAction(Notification.Action.Builder(null, "Stop", stop).build())
            .build()
    }

    companion object {
        const val ACTION_START = "io.github.housecast.START"
        const val ACTION_STOP = "io.github.housecast.STOP"
        const val EXTRA_CODE = "code"
        const val EXTRA_DATA = "data"
        private const val CHANNEL = "capture"
        private const val NOTIFICATION_ID = 1
    }
}
