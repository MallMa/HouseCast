# Third-party notices

Housecast is distributed under the MIT License (see `LICENSE`).

The packaged application includes Electron and fast-xml-parser, each under its
own MIT license, included with the packaged dependencies. Electron also ships
Chromium and Node.js license notices in the application folder
(`LICENSE.electron.txt`, `LICENSES.chromium.html`).

The FLAC writer is an original implementation of fixed-block,
independent-channel, verbatim subframes as described in RFC 9639:
https://www.rfc-editor.org/rfc/rfc9639.html. The application does not bundle an
FFmpeg executable or library.

Development tests use ffmpeg-static solely as an independent decoder to check
generated samples. That package and its binary have their own license and
corresponding-source requirements and are excluded from the application
distribution:
- https://github.com/eugeneware/ffmpeg-static
- https://ffmpeg.org/legal.html

Playwright, Prettier and electron-builder are development tools and are not
included in the running application.

## Trademarks

Sonos is a trademark of Sonos, Inc. Housecast is not affiliated with, endorsed
by or sponsored by Sonos, Inc. Product names are used only to describe
compatibility.
