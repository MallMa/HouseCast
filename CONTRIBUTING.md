# Contributing to Housecast

Thanks for helping! Housecast is a small, dependency-light Electron app.

## Getting started

```powershell
npm ci
npm start
npm test
```

Before opening a pull request:

1. `npm test` passes.
2. `npm run format` has been run (Prettier).
3. New behavior that does not need real speakers has a unit test in `test/`.

## Ground rules

- **Keep it local.** No cloud services, accounts, telemetry or analytics.
- **Never commit captured data.** `diagnostics/`, `test-output/` and exported
  reports contain room names, LAN addresses and device IDs. They are git-ignored;
  keep it that way.
- **Be careful with real speakers.** Scripts that change playback must cap
  volume (the existing ones use 30%), mute where possible and restore the
  previous state.
- **No branding of third parties.** Don't add manufacturer logos, product
  images or names to the app's identity. Mention speaker brands only to
  describe compatibility.
- **Model-agnostic code.** Don't hard-code room names, IP addresses or a
  specific speaker model. Use capabilities from the device description where
  possible (for example the `HTControl` service for home-theater players).

## Testing on hardware

Reports from different speaker models, firmware versions and network setups
(mesh Wi-Fi, VLANs, Ethernet) are very valuable. If something fails, include
your speaker models and an exported report with private details removed.
