# Changelog

## 0.3.0 — first public release

- Renamed the project to **Housecast**. App data now lives in
  `%APPDATA%\Housecast`; saved speakers are rediscovered automatically on
  first start.
- Bluetooth sharing works with any Bluetooth-capable speaker that is currently
  playing Bluetooth, not just one specific soundbar model.
- Group coordinator selection prefers any home-theater player (detected via
  its `HTControl` service or model name) instead of one hard-coded model.
- Room icons pick the soundbar or speaker symbol based on the device type.
- The footer shows the real application version.
- Quit handlers are registered before the window loads, so closing the app
  during a failed load still stops capture and restores sources.
- New per-user Windows installer (`Housecast-<version>-Windows-Setup.exe`)
  next to the portable exe.
- Added MIT license, contributor guide, security policy, CI and a generic
  read-only UI smoke test.

## 0.2.2

- Capture-only audio worklet with no playback output. Fixes streams stopping
  after 30–60 seconds when Chromium switched to a slower timer-driven clock.
- Diagnostics include capture delivery drift (`captureLagMs`).

## 0.2.1

- Up to 30 seconds to open Windows capture on a busy PC; six-second stall
  timeout once capture is running.
- **Reconnect audio** button; ended desktop streams are never restored.

## 0.2.0

- New Playback and Settings interface with a full speaker inventory,
  automatic discovery and subnet scanning.

## 0.1.x

- Initial desktop streaming (FLAC/PCM), room control, grouping, safe restore,
  faster reconnection of saved speakers.
