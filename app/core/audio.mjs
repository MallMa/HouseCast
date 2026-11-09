import { randomUUID } from "node:crypto";
import { streamMetadata, isHomeTheater } from "./protocol.mjs";
import { FlacEncoder } from "./flac.mjs";

export const SAMPLE_RATE = 48000;
export const WAV_DATA_SIZE = 0x7ffff000;
export function wavHeader() {
  const b = Buffer.alloc(44);
  b.write("RIFF");
  b.writeUInt32LE(WAV_DATA_SIZE + 36, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(2, 22);
  b.writeUInt32LE(SAMPLE_RATE, 24);
  b.writeUInt32LE(SAMPLE_RATE * 4, 28);
  b.writeUInt16LE(4, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(WAV_DATA_SIZE, 40);
  return b;
}
export function pcm16(floatBuffer) {
  const input = new Float32Array(
      floatBuffer.buffer,
      floatBuffer.byteOffset,
      floatBuffer.length / 4,
    ),
    output = Buffer.allocUnsafe(input.length * 2);
  for (let i = 0; i < input.length; i++) {
    const v = Number.isFinite(input[i])
      ? Math.max(-1, Math.min(1, input[i]))
      : 0;
    output.writeInt16LE(Math.round(v * (v < 0 ? 32768 : 32767)), i * 2);
  }
  return output;
}
export class DesktopAudio {
  constructor(controller) {
    this.controller = controller;
    controller.audio = this;
    this.session = null;
    this.clients = new Set();
  }
  snapshot() {
    const s = this.session;
    return s
      ? {
          active: true,
          id: s.id,
          format: s.format,
          phase: s.phase,
          targets: s.targets,
          clients: this.clients.size,
          receivedFrames: s.frames,
          seconds: s.frames / SAMPLE_RATE,
          bytesSent: s.bytesSent,
          startedAt: s.startedAt,
          lastPacket: s.lastPacket,
          level: s.level,
          error: s.error,
          restored: s.restored,
          lastSignalAt: s.lastSignalAt || null,
          captureLagMs: this.captureLag(s),
          health: this.health(s),
        }
      : { active: false, error: this.lastError || null };
  }
  captureLag(s = this.session) {
    if (s?.captureClock === undefined) return null;
    // Monotonic time distinguishes a producer falling behind from a wall-clock
    // adjustment. This is delivery drift, not speaker or acoustic latency.
    return Math.round(performance.now() - s.captureClock - s.frames / 48);
  }
  health(s = this.session) {
    if (!s) return { code: "idle", message: "Ready to stream" };
    if (s.phase !== "streaming")
      return {
        code: s.phase,
        message:
          s.phase === "capturing"
            ? "Opening Windows audio capture…"
            : s.phase === "connecting"
              ? "Waiting for speaker playback…"
              : "Stopping desktop audio…",
      };
    const rooms = s.targets.map((id) => this.controller.rooms.get(id));
    const coordinator = this.controller.rooms.get(s.coordinator);
    if (Date.now() - s.lastPacket > 1500)
      return {
        code: "capture-stalled",
        message: "Windows audio capture is not sending samples.",
      };
    if (!this.clients.size || !coordinator?.online)
      return {
        code: "disconnected",
        message: "The speaker audio connection is interrupted.",
      };
    if (coordinator?.state !== "PLAYING")
      return {
        code: "not-playing",
        message: "The speaker has stopped playing. Reconnect audio to resume.",
      };
    if (rooms.every((r) => r?.mute || r?.volume === 0))
      return {
        code: "muted",
        message: "The selected rooms are muted or at zero volume.",
      };
    if (Date.now() - (s.lastSignalAt || s.startedAt) > 3000)
      return {
        code: "silent",
        message:
          "No sound is arriving from Windows. Check the playing app’s output, or reconnect audio.",
      };
    return {
      code: "receiving",
      message: "Windows audio detected · speaker receiving stream",
    };
  }
  trace(event, extra = {}) {
    const s = this.session;
    this.controller.diagnostics?.write(event, {
      phase: s?.phase,
      format: s?.format,
      frames: s?.frames,
      bytes: s?.bytesSent,
      clients: this.clients.size,
      level: s?.level,
      health: s ? this.health(s).code : undefined,
      captureLagMs: this.captureLag(s),
      ...extra,
    });
  }
  prepare(ids, format) {
    if (this.session || this.stopping)
      throw new Error("Desktop audio is already running or still stopping.");
    if (!["pcm16", "flac24"].includes(format))
      throw new Error("Unknown audio format.");
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > 16 ||
      new Set(ids).size !== ids.length
    )
      throw new Error("Select at least one room.");
    ids.forEach((id) => this.controller.requireRoom(id));
    this.lastError = null;
    const id = randomUUID(),
      ext = format === "flac24" ? "flac" : "wav";
    this.session = {
      id,
      format,
      targets: ids,
      url: `${this.controller.baseUrl}/audio/${id}/desktop.${ext}`,
      phase: "capturing",
      frames: 0,
      bytesSent: 0,
      startedAt: Date.now(),
      lastPacket: Date.now(),
      level: 0,
    };
    this.trace("capture-requested");
    this.watchdog = setInterval(() => {
      const s = this.session;
      if (
        s?.phase === "streaming" &&
        !this.clients.size &&
        Date.now() - (s.disconnectedAt || Date.now()) > 6000
      ) {
        this.lastError =
          "The speaker disconnected. Reconnect desktop audio to resume.";
        void this.stop(true).catch((e) =>
          this.controller.log(e.message, "error"),
        );
        this.controller.log(
          "The speaker disconnected from desktop audio. Restart streaming to reconnect.",
          "error",
        );
        return;
      }
      // Opening a Windows capture device is not an active stream outage. On a
      // busy PC the first getDisplayMedia call can legitimately take >6 seconds.
      const captureTimeout =
        s?.phase === "capturing" && !s.frames ? 30000 : 6000;
      if (
        s &&
        s.phase !== "stopping" &&
        Date.now() - s.lastPacket > captureTimeout
      ) {
        this.lastError =
          "Windows audio capture stopped responding. Start streaming again to reconnect.";
        this.controller.log(
          "Desktop capture stopped sending audio. The stream has been stopped.",
          "error",
        );
        void this.stop(true).catch((e) =>
          this.controller.log(e.message, "error"),
        );
      }
      if (s && (!s.lastTrace || Date.now() - s.lastTrace > 10000)) {
        s.lastTrace = Date.now();
        this.trace("stream-health", {
          rooms: s.targets.map((id) => {
            const r = this.controller.rooms?.get(id);
            return {
              id,
              state: r?.state,
              online: r?.online,
              mute: r?.mute,
              volume: r?.volume,
            };
          }),
        });
      }
    }, 2000);
    this.controller.emitState();
    return { id, format };
  }
  push(id, arrayBuffer, level = 0) {
    const s = this.session;
    if (
      !s ||
      s.phase === "stopping" ||
      id !== s.id ||
      !(arrayBuffer instanceof ArrayBuffer) ||
      arrayBuffer.byteLength === 0 ||
      arrayBuffer.byteLength > 32768 ||
      arrayBuffer.byteLength % 8
    )
      return;
    const chunk = Buffer.from(arrayBuffer);
    if (s.format === "pcm16" && s.frames * 4 > WAV_DATA_SIZE - 192000) {
      void this.stop(true).catch((e) =>
        this.controller.log(e.message, "error"),
      );
      this.controller.log(
        "The PCM session reached its WAV size limit. Restart streaming, or choose FLAC for longer listening.",
        "error",
      );
      return;
    }
    if (s.captureClock === undefined)
      s.captureClock = performance.now() - chunk.length / 8 / 48;
    s.frames += chunk.length / 8;
    s.lastPacket = Date.now();
    s.level = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
    if (s.level > 0.00001) s.lastSignalAt = Date.now();
    // A live listener starts with the next capture packet. Replaying history on
    // connection/reconnection is unnecessary for a desktop audio source.
    let pcm;
    for (const client of this.clients) {
      if (client.encoder) client.encoder.push(chunk);
      else {
        pcm ??= pcm16(chunk);
        this.write(client, pcm);
      }
    }
    if (!s.lastEmit || Date.now() - s.lastEmit > 200) {
      s.lastEmit = Date.now();
      this.controller.emitState();
    }
  }
  write(client, chunk) {
    if (client.closed) return;
    if (client.res.writableLength > 192000) {
      this.drop(client, "A speaker stopped reading audio.");
      return;
    }
    client.res.write(chunk);
    if (this.session) this.session.bytesSent += chunk.length;
  }
  drop(client, message) {
    if (client.closed) return;
    client.closed = true;
    this.clients.delete(client);
    client.res.destroy();
    if (this.session) this.session.disconnectedAt = Date.now();
    if (message) this.controller.log(message, "error");
    this.trace("speaker-disconnected", {
      peer: client.peer,
      reason: message || "connection closed",
    });
    this.controller.emitState();
  }
  handle(req, res) {
    if (!req.url?.startsWith("/audio/")) return false;
    const s = this.session,
      peer = req.socket.remoteAddress;
    if (
      !s ||
      req.url !== new URL(s.url).pathname ||
      ![...this.controller.devices.values()].some((d) => d.host === peer) ||
      !["GET", "HEAD"].includes(req.method)
    ) {
      res.writeHead(404).end();
      req.resume();
      return true;
    }
    // Separating a group can make a follower request the coordinator's former
    // stream. Never admit a new reader while stopping: capture has ceased, so
    // that reader would wait forever and block the speaker's next source change.
    if (s.phase === "stopping") {
      this.trace("ended-stream-request", { peer });
      res.writeHead(410, { Connection: "close", "Content-Length": "0" }).end();
      req.resume();
      return true;
    }
    if (this.clients.size >= 4 && req.method === "GET") {
      res.writeHead(503).end();
      return true;
    }
    const range = req.headers.range;
    let offset = 0;
    if (range) {
      const match = range.match(/^bytes=(\d+)-$/);
      if (
        !match ||
        ![0, 44].includes(+match[1]) ||
        (s.format === "flac24" && +match[1] !== 0)
      ) {
        this.trace("unsupported-seek", { peer, range });
        res.writeHead(416, { "Accept-Ranges": "none" }).end();
        return true;
      }
      offset = +match[1];
    }
    const headers = {
      "Content-Type": s.format === "flac24" ? "audio/flac" : "audio/wav",
      "Cache-Control": "no-store",
      Connection: "close",
      "transferMode.dlna.org": "Streaming",
      "contentFeatures.dlna.org":
        "DLNA.ORG_OP=00;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000",
      "Accept-Ranges": "none",
    };
    if (s.format === "pcm16") {
      headers["Content-Length"] = String(WAV_DATA_SIZE + 44 - offset);
      if (range)
        headers["Content-Range"] =
          `bytes ${offset}-${WAV_DATA_SIZE + 43}/${WAV_DATA_SIZE + 44}`;
    }
    res.useChunkedEncodingByDefault = s.format === "flac24";
    res.writeHead(range && s.format === "pcm16" ? 206 : 200, headers);
    res.flushHeaders();
    if (req.method === "HEAD") {
      res.end();
      return true;
    }
    req.socket.setNoDelay(true);
    req.socket.setTimeout(0);
    const client = { res, encoder: null, closed: false, peer };
    this.clients.add(client);
    res.on("error", () => this.drop(client));
    res.on("close", () => this.drop(client));
    if (s.format === "pcm16") {
      if (!offset) this.write(client, wavHeader());
    } else {
      client.encoder = new FlacEncoder((chunk) => this.write(client, chunk));
    }
    s.connectedAt = Date.now();
    this.trace("speaker-connected", { peer, range });
    this.controller.emitState();
    return true;
  }
  async play(id) {
    const s = this.session;
    if (!s || s.id !== id || s.phase !== "capturing")
      throw new Error("Capture session expired.");
    if (s.frames === 0)
      throw new Error("Desktop capture has not provided audio yet.");
    s.phase = "connecting";
    this.controller.emitState();
    try {
      s.before = await this.controller.captureSnapshot();
      if (this.session !== s || s.phase === "stopping")
        throw new Error("Stream was cancelled.");
      s.coordinator =
        s.targets.find((id) => isHomeTheater(this.controller.rooms.get(id))) ||
        s.targets[0];
      const current = this.controller.groups.find((g) =>
        g.ids.includes(s.coordinator),
      );
      if (
        current &&
        (current.coordinator !== s.coordinator ||
          current.ids.some((id) => !s.targets.includes(id)))
      )
        await this.controller.soap(
          s.coordinator,
          "AVTransport",
          "BecomeCoordinatorOfStandaloneGroup",
          { InstanceID: 0 },
        );
      s.changed = true;
      await this.controller.setSource(
        s.coordinator,
        s.url,
        streamMetadata(s.url, s.format),
        true,
      );
      if (this.session !== s || s.phase === "stopping")
        throw new Error("Stream was cancelled.");
      const deadline = Date.now() + 9000;
      while (Date.now() < deadline) {
        if (this.session !== s || s.phase === "stopping")
          throw new Error("Stream was cancelled.");
        await this.controller.refreshRoom(s.coordinator);
        if (
          this.clients.size &&
          s.bytesSent > 4096 &&
          this.controller.rooms.get(s.coordinator)?.uri === s.url &&
          this.controller.rooms.get(s.coordinator)?.state === "PLAYING"
        ) {
          await this.controller.group(s.targets, s.coordinator);
          if (this.session !== s || s.phase === "stopping")
            throw new Error("Stream was cancelled.");
          s.phase = "streaming";
          this.controller.log(
            "Desktop audio is being received by the speakers.",
          );
          this.controller.emitState();
          return this.snapshot();
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      this.controller.log(
        `Stream check: ${s.frames} captured frames, ${this.clients.size} connections, ${s.bytesSent} bytes sent; speaker ${this.controller.rooms.get(s.coordinator)?.state}.`,
        "error",
      );
      throw new Error(
        s.bytesSent === 0
          ? "The speaker cannot connect back to this PC. Open Settings → Allow speaker connections, then retry."
          : "The speaker did not confirm playback. Check its network connection, or try PCM compatibility mode.",
      );
    } catch (error) {
      this.lastError = error.message;
      await this.stop(true).catch((restoreError) =>
        this.controller.log(
          `Could not restore the earlier source: ${restoreError.message}`,
          "error",
        ),
      );
      throw error;
    }
  }
  async stop(restore = true) {
    if (this.stopping) return this.stopping;
    const s = this.session;
    if (!s) return { restored: false };
    s.phase = "stopping";
    this.controller.emitState();
    // Close the live HTTP body first. Some players serialize transport commands
    // behind their decoder's pending network read; pausing the producer alone
    // can make Stop/GetMediaInfo wait indefinitely for more bytes.
    for (const client of [...this.clients]) this.drop(client);
    this.stopping = (async () => {
      let restored = false;
      try {
        if (restore && s.changed && s.before)
          restored = await this.controller.restore(
            s.before,
            s.url,
            s.coordinator,
            s.targets,
          );
      } finally {
        clearInterval(this.watchdog);
        for (const c of [...this.clients]) this.drop(c);
        this.session = null;
        this.controller.emitState();
      }
      return { restored };
    })().finally(() => {
      this.stopping = null;
    });
    return this.stopping;
  }
}
