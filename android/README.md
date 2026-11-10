# Housecast for Android (preview)

Stream whatever your Android phone is playing to the speakers in every room,
and control those rooms: volume, mute, play/pause, grouping and Bluetooth
sharing. Like the Windows app it is fully local: no account, no cloud, and
audio is never saved.

This is an early preview. It has been built and unit-tested, but it has had
very little testing on real phones and speakers.

## Install

1. On your phone, open the
   [Android preview release](../../../releases/tag/android-preview) and
   download `Housecast-android-preview.apk`.
2. Open the downloaded file. Android will ask you to allow installing apps
   from your browser or file manager; allow it and install.

Requires Android 10 or newer. Every build is signed with the same preview key,
so a newer preview installs over an older one.

## Use

1. Connect the phone to the same Wi-Fi network as your speakers. Rooms appear
   on the **Rooms** tab.
2. Tick the rooms you want, choose **Lossless (FLAC)** or
   **Compatibility (PCM)** and tap **Stream phone audio**.
3. Android asks for the recording permission and then to "start recording or
   casting". Housecast only uses the audio; choose the whole screen/device
   option if asked.
4. Tap **Stop streaming** (in the app or the notification) to put the rooms
   back on what they played before.

## Which apps can be streamed?

Android only lets one app capture another app's sound if that app allows it.
The **Capture check** tab answers this for your phone:

- **Live test** captures without sending anything to the speakers. Start it,
  switch to the app you care about, play something for a few seconds and come
  back. If "seconds with sound" went up, that app can be streamed.
- **Installed apps** shows whether each app's manifest allows capture
  (`android:allowAudioPlaybackCapture`). An app that allows it can still
  protect individual streams, so the live test is the definitive answer.

Phone calls, alarms and notification sounds are never captured.

## Known limitations

- Around a second or more of delay, as on Windows: fine for music, not for
  video or games.
- **Mute this phone while streaming** is experimental; it sets the media
  volume to zero and restores it afterwards.
- 16-bit / 48 kHz stereo (what Android's playback capture provides).
- PCM mode stops after about 3.1 hours (WAV size limit); FLAC has no limit.
- Some phones stop background apps aggressively. If a stream stops with the
  screen off, exclude Housecast from battery optimisation.

## Build

Requires JDK 17 or newer and the Android SDK (platform 35).

```sh
cd android
./gradlew testDebugUnitTest   # unit tests and an end-to-end stream test, no speakers needed
./gradlew assembleDebug       # app/build/outputs/apk/debug/app-debug.apk
```

`preview.keystore` is a throwaway signing key committed on purpose so preview
builds can update each other. It must never be used for a store release.

## Layout

- `core/` is a Kotlin port of the desktop app's `app/core`: speaker protocol,
  discovery, controller, FLAC/WAV stream server. It has no Android
  dependencies and is covered by the unit tests.
- `CaptureService` owns playback capture (MediaProjection) as a foreground
  service. `CaptureCheck` reads other apps' capture policy.
- `ui/` is the Jetpack Compose interface.
