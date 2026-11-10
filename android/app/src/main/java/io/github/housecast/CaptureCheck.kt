package io.github.housecast

import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import org.xmlpull.v1.XmlPullParser

enum class CaptureVerdict { ALLOWED, BLOCKED, UNKNOWN }

class AppCapture(val packageName: String, val label: String, val verdict: CaptureVerdict, val popular: Boolean)

/**
 * Reads, for each installed launcher app, whether its manifest lets other apps
 * capture its audio (android:allowAudioPlaybackCapture). This is the app-wide
 * switch; an app that passes can still protect individual streams, so the live
 * test remains the definitive answer.
 */
object CaptureCheck {
    private val POPULAR = setOf(
        "com.spotify.music",
        "com.google.android.youtube",
        "com.google.android.apps.youtube.music",
        "com.apple.android.music",
        "com.amazon.mp3",
        "com.aspiro.tidal",
        "deezer.android.app",
        "com.soundcloud.android",
        "com.qobuz.music",
        "com.pandora.android",
        "com.audible.application",
        "au.com.shiftyjelly.pocketcasts",
        "com.bambuna.podcastaddict",
        "com.google.android.apps.podcasts",
        "tunein.player",
        "com.netflix.mediaclient",
        "com.amazon.avod.thirdpartyclient",
        "com.disney.disneyplus",
        "tv.twitch.android.app",
        "com.plexapp.android",
        "org.videolan.vlc",
        "com.android.chrome",
        "org.mozilla.firefox",
        "com.brave.browser",
        "com.sec.android.app.sbrowser",
        "com.sec.android.app.music",
        "com.zhiliaoapp.musically",
        "com.instagram.android",
        "com.bandcamp.android",
        "com.tidal.android",
    )

    fun scan(context: Context): List<AppCapture> {
        val manager = context.packageManager
        val launcher = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        return manager.queryIntentActivities(launcher, 0)
            .map { it.activityInfo.applicationInfo }
            .distinctBy { it.packageName }
            .filter { it.packageName != context.packageName }
            .map { info ->
                AppCapture(
                    info.packageName,
                    info.loadLabel(manager).toString(),
                    inspect(context, info),
                    info.packageName in POPULAR,
                )
            }
            .sortedWith(compareByDescending<AppCapture> { it.popular }.thenBy { it.label.lowercase() })
    }

    private fun inspect(context: Context, info: ApplicationInfo): CaptureVerdict {
        // Apps built for Android 9 or older are not capturable unless they opt in.
        var allowed = info.targetSdkVersion >= 29
        try {
            val assets = context.createPackageContext(info.packageName, 0).assets
            for (cookie in 1..16) {
                val parser = try {
                    assets.openXmlResourceParser(cookie, "AndroidManifest.xml")
                } catch (e: Exception) {
                    continue
                }
                parser.use {
                    var event = it.eventType
                    var ours = false
                    while (event != XmlPullParser.END_DOCUMENT) {
                        if (event == XmlPullParser.START_TAG) {
                            if (it.name == "manifest") {
                                // The framework's own manifest is on the asset path too.
                                if (it.getAttributeValue(null, "package") != info.packageName) break
                                ours = true
                            } else if (it.name == "application" && ours) {
                                for (i in 0 until it.attributeCount)
                                    if (it.getAttributeNameResource(i) == android.R.attr.allowAudioPlaybackCapture ||
                                        it.getAttributeName(i) == "allowAudioPlaybackCapture"
                                    ) allowed = it.getAttributeBooleanValue(i, allowed)
                                return if (allowed) CaptureVerdict.ALLOWED else CaptureVerdict.BLOCKED
                            }
                        }
                        event = it.next()
                    }
                }
            }
        } catch (e: Exception) {
            return CaptureVerdict.UNKNOWN
        }
        return CaptureVerdict.UNKNOWN
    }
}
