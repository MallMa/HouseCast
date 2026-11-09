# Housecast

**Stream whatever is playing on your Windows PC to the speakers in every room.** Free, open source and fully local: no account, no cloud, no subscription.

Housecast captures your PC's sound (music, browser, games, anything) and sends it over your home network to one room, several rooms or your whole house. It also gives you quick room controls: volume, mute, play/pause, grouping and Bluetooth sharing.

Housecast works with **Sonos®** speakers using their local network interface. It is an independent project and is **not affiliated with, endorsed by or sponsored by Sonos, Inc.** See [Trademarks](#trademarks).

## Features

- **Desktop audio to any room.** Stream your PC's default playback output to one or more rooms at once.
- **Two quality modes.** Lossless 24-bit / 48 kHz FLAC (about 2.3 Mbit/s) or 16-bit / 48 kHz PCM for compatibility.
- **Room controls.** Volume, mute, play/pause, group and separate rooms. Bonded surrounds and subwoofers stay with their room.
- **Bluetooth sharing.** Play your phone over Bluetooth on a Bluetooth-capable speaker, then share that source with every other room.
- **Safe restore.** When you stop streaming, Housecast tries to put each room back on the source and grouping it had before, unless you picked something else in the meantime.
- **Automatic discovery.** Finds speakers via multicast discovery, remembers them, and can scan your subnet when multicast is blocked. You can also add a speaker by IP address.
- **Private by design.** Everything stays on your LAN. No audio is ever saved. Diagnostic logs contain only counters and connection events.

## Requirements

- Windows 10 or 11 (desktop audio capture uses Windows loopback; macOS and Linux are not supported yet)
- Speakers on the same local network/subnet as the PC (Ethernet or Wi-Fi)

## Install

1. Download `Housecast-<version>-Windows-portable.exe` from the [Releases](../../releases) page.
2. Run it. It is a portable app; no installation is needed.

The executable is not code-signed, so Windows SmartScreen may show **"Windows protected your PC"**. Choose **More info → Run anyway**, or build it yourself from source (below).

## Use

1. Open Housecast. Your rooms appear automatically. If they don't, open **Settings** and select the network adapter that is on the same network as your speakers, then click **Search now**.
2. Select the rooms you want to hear your PC in.
3. Pick **Lossless (FLAC)** or **Compatibility (PCM)**.
4. Click **Stream desktop**. The status shows whether Windows audio is arriving and whether the speakers are playing.
5. Click **Stop streaming** to release the capture and restore the previous sources and groups.

**Mute PC playback** captures your audio while silencing the PC's own speakers. It takes effect the next time you start streaming.

### If the speakers can't connect back

Speakers pull the audio from your PC over HTTP, so Windows Firewall must allow incoming connections from your home network. If room control works but streaming fails, open **Settings → Allow speaker connections**. Windows will ask for administrator approval.

The [helper script](app/platform/allow-home-network.ps1) (you can review it) adds a single inbound TCP rule that only applies to the Housecast executable, your selected local address and your home subnet. It does not disable the firewall, change your network profile, open router ports or touch unrelated rules. If you move the app or your PC's address changes, run it again.

### Audio delay: what to expect

The speakers buffer network audio, so there is a noticeable delay between your PC and the speakers (typically around a second or more, depending on the speaker and network). This is fine for music, podcasts and radio, but **video and games will be out of sync**. Muting PC playback removes the echo but not the delay. For a TV or game setup, a wired HDMI connection to a soundbar is the better route.

## Limitations

- Stereo only; surround/Atmos desktop audio is not supported.
- Windows-only for now.
- Protected (DRM) content may not be capturable.
- Changing the Windows default audio output during a stream may require restarting it.
- PCM mode stops after about 3.1 hours (WAV size limit). FLAC has no such limit.
- Bluetooth sharing can only use a session the speaker already has; Housecast cannot pair new devices.
- The speakers' local interface is not an officially documented public API. Firmware updates may require compatibility fixes.

## Troubleshooting

| Problem | Try |
| --- | --- |
| No rooms appear | Settings → choose the right network adapter (not a VPN/virtual adapter) → Search now. Or add a speaker by IP. |
| Rooms appear but streaming never starts | Settings → Allow speaker connections. Check that your router doesn't isolate Wi-Fi clients (guest networks often do). |
| "No sound is arriving from Windows" | Make sure something is playing on the Windows **default** output device. |
| Stream stops after a while | Try PCM mode, check Wi-Fi signal at the speaker, then export a report (Settings → Export report) and open an issue. |

Diagnostic history is stored in `%APPDATA%\Housecast\stream-diagnostics.jsonl` (two rotating files of about 2 MB). Exported reports contain room names, LAN addresses and device identifiers; review them before sharing.

## Build from source

Requires Node.js 22.12 or newer on Windows.

```powershell
npm ci
npm start          # run in development
npm test           # unit tests, no speakers needed
npm run dist       # build release/Housecast-<version>-Windows-portable.exe
```

### Project layout

| Path | What it does |
| --- | --- |
| `app/main.mjs` | Electron main process: window, permissions, IPC |
| `app/core/controller.mjs` | Discovery, speaker state, grouping, event subscriptions |
| `app/core/audio.mjs` | Desktop stream session and the HTTP audio server |
| `app/core/flac.mjs` | Pure-JavaScript FLAC encoder (RFC 9639 verbatim subframes) |
| `app/core/protocol.mjs` | UPnP/SOAP helpers and XML parsing |
| `app/renderer/` | User interface and the audio capture worklet |
| `app/platform/allow-home-network.ps1` | Optional firewall helper |
| `scripts/` | Read-only diagnostics and opt-in hardware tests |

### Tests

`npm test` runs offline and checks topology parsing, SOAP handling, safe restoration, PCM framing and sample-exact FLAC decoding (FFmpeg is used only as an independent test decoder; it is not shipped).

Opt-in tests against real speakers:

```powershell
npm run test:ui                                     # read-only UI smoke test
node scripts/stream-soak.mjs --seconds=300 --format=flac24
```

The soak test mutes the selected rooms, caps every volume write at 30%, streams for the given time and then restores the previous state. Run it when nobody else is using the system.

Read-only network diagnostics:

```powershell
node scripts/discover-speakers.mjs --interface <your-pc-ip>
node scripts/discover-mdns.mjs <your-pc-ip>
./scripts/Inspect-Speaker.ps1 -Address <speaker-ip> -Samples 30
node scripts/test-speaker-events.mjs <speaker-ip> <your-pc-ip>
```

Output goes to the git-ignored `diagnostics/` and `test-output/` folders, because it contains device identifiers and LAN addresses.

## Security

The renderer is sandboxed with context isolation, no Node integration, a strict Content Security Policy and a narrow, validated IPC bridge. The audio stream is served at a random per-session URL and only to addresses of discovered speakers; event callbacks require a random token and must come from the speaker they belong to. All speaker requests are restricted to the selected local subnet, and responses and buffers are size-limited. See [SECURITY.md](SECURITY.md) to report a vulnerability.

## Contributing

Bug reports, testing on different speaker models and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Trademarks

Sonos is a trademark of Sonos, Inc. All other product names are trademarks of their respective owners. They are used here only to describe compatibility. Housecast is an independent, community-maintained project. It is not affiliated with, endorsed by or sponsored by Sonos, Inc., and it contains no Sonos code, logos or other assets.

## License

[MIT](LICENSE). Third-party notices: [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
