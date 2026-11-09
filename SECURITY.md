# Security policy

Please report security problems privately using GitHub's
**Security → Report a vulnerability** on this repository, rather than in a
public issue.

Useful details: affected version, what an attacker on the local network (or a
malicious web page/speaker response) could do, and steps to reproduce.

## Scope

Housecast runs a small HTTP server on your selected LAN interface for audio
streams and speaker event callbacks, and sends UPnP/SOAP requests to speakers
on the same subnet. Relevant issues include anything that lets another device
or web content read the audio stream, control speakers through Housecast,
reach the Electron main process, or escape the renderer sandbox.
