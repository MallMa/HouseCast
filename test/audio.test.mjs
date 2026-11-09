import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import ffmpeg from "ffmpeg-static";
import http from "node:http";
import {
  wavHeader,
  pcm16,
  DesktopAudio,
  WAV_DATA_SIZE,
} from "../app/core/audio.mjs";
import { FlacEncoder, quantize24, BLOCK_FRAMES } from "../app/core/flac.mjs";

test("A follower reconnecting during group restoration receives an ended stream, never a waiting audio body", async () => {
  const c = {
    devices: new Map([["A", { host: "127.0.0.1" }]]),
    requireRoom() {},
    emitState() {},
    log() {},
  };
  const audio = new DesktopAudio(c),
    server = http.createServer((req, res) => audio.handle(req, res));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  c.baseUrl = `http://127.0.0.1:${server.address().port}`;
  audio.prepare(["A"], "flac24");
  Object.assign(audio.session, { changed: true, before: {}, coordinator: "A" });
  c.restore = async () => {
    const response = await fetch(audio.session.url);
    assert.equal(response.status, 410);
    assert.equal(await response.text(), "");
    assert.equal(audio.clients.size, 0);
    return true;
  };
  try {
    assert.equal((await audio.stop(true)).restored, true);
  } finally {
    await audio.stop(false);
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

test("Opening Windows capture can take longer than the active-stream timeout", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 100000 });
  const c = {
    devices: new Map(),
    baseUrl: "http://127.0.0.1:1",
    requireRoom() {},
    emitState() {},
    log() {},
  };
  const audio = new DesktopAudio(c);
  audio.prepare(["A"], "pcm16");
  t.mock.timers.tick(8000);
  assert.equal(audio.session.phase, "capturing");
  audio.push(audio.session.id, new Float32Array(512).buffer);
  t.mock.timers.tick(8000);
  await audio.stopping;
  assert.equal(
    audio.session,
    null,
    "Once started, a stalled producer must still stop",
  );
});

test("Live status distinguishes silence, muted rooms and stopped playback", async () => {
  const c = {
    devices: new Map(),
    rooms: new Map([
      ["A", { online: true, state: "PLAYING", mute: false, volume: 20 }],
    ]),
    baseUrl: "http://127.0.0.1:1",
    requireRoom() {},
    emitState() {},
    log() {},
  };
  const audio = new DesktopAudio(c);
  audio.prepare(["A"], "pcm16");
  Object.assign(audio.session, {
    phase: "streaming",
    coordinator: "A",
    startedAt: Date.now() - 10000,
  });
  const client = { res: { destroy() {} } };
  audio.clients.add(client);
  assert.equal(audio.snapshot().health.code, "silent");
  audio.session.lastSignalAt = Date.now();
  assert.equal(audio.snapshot().health.code, "receiving");
  c.rooms.get("A").mute = true;
  assert.equal(audio.snapshot().health.code, "muted");
  c.rooms.get("A").state = "STOPPED";
  assert.equal(audio.snapshot().health.code, "not-playing");
  audio.clients.clear();
  assert.equal(audio.snapshot().health.code, "disconnected");
  await audio.stop(false);
});

test("Cancellation during the initial snapshot cannot start an expired stream", async () => {
  let finish;
  const c = {
    devices: new Map(),
    baseUrl: "http://127.0.0.1:1",
    requireRoom() {},
    emitState() {},
    log() {},
    captureSnapshot: () => new Promise((r) => (finish = r)),
    setSource() {
      assert.fail("Cancelled capture must not change a speaker source");
    },
  };
  const audio = new DesktopAudio(c),
    { id } = audio.prepare(["A"], "pcm16");
  audio.push(id, new Float32Array(512).buffer);
  const start = audio.play(id);
  await audio.stop(false);
  finish({ groups: [], rooms: [] });
  await assert.rejects(start, /cancelled/);
  assert.equal(audio.session, null);
});

test("Stopping releases a waiting HTTP reader before restoring speaker state", async () => {
  let speakerClosed;
  const connectionClosed = new Promise((resolve) => (speakerClosed = resolve));
  const c = {
    devices: new Map([["A", { host: "127.0.0.1" }]]),
    requireRoom() {},
    emitState() {},
    log() {},
    async restore() {
      await connectionClosed;
      return true;
    },
  };
  const audio = new DesktopAudio(c),
    server = http.createServer((req, res) => audio.handle(req, res));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  c.baseUrl = `http://127.0.0.1:${server.address().port}`;
  audio.prepare(["A"], "pcm16");
  Object.assign(audio.session, { changed: true, before: {}, coordinator: "A" });
  let request;
  await new Promise((resolve, reject) => {
    request = http.get(audio.session.url, (res) => {
      res.on("error", () => {});
      res.on("close", speakerClosed);
      res.resume();
      resolve();
    });
    request.on("error", reject);
  });
  let timer;
  try {
    const result = await Promise.race([
      audio.stop(true),
      new Promise(
        (_, reject) =>
          (timer = setTimeout(
            () =>
              reject(
                new Error(
                  "Restoration waited for an audio connection that never closed.",
                ),
              ),
            1500,
          )),
      ),
    ]);
    assert.equal(result.restored, true);
    assert.equal(audio.clients.size, 0);
  } finally {
    clearTimeout(timer);
    request.destroy();
    speakerClosed();
    await audio.stop(false);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("HTTP streams require the current token and a discovered speaker; unsupported seeks fail", async () => {
  const c = {
    devices: new Map([["A", { host: "127.0.0.1" }]]),
    requireRoom() {},
    emitState() {},
    log() {},
  };
  const audio = new DesktopAudio(c);
  const server = http.createServer((req, res) => {
    if (!audio.handle(req, res)) res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  c.baseUrl = `http://127.0.0.1:${server.address().port}`;
  const session = audio.prepare(["A"], "pcm16"),
    url = audio.session.url;
  const request = (url, headers = {}) =>
    new Promise((resolve, reject) => {
      const req = http.request(url, { method: "HEAD", headers }, (res) => {
        res.resume();
        resolve({ status: res.statusCode, headers: res.headers });
      });
      req.on("error", reject);
      req.end();
    });
  try {
    const good = await request(url);
    assert.equal(good.status, 200);
    assert.equal(good.headers["content-type"], "audio/wav");
    assert.equal(audio.clients.size, 0);
    assert.equal((await request(url, { Range: "bytes=1048576-" })).status, 416);
    assert.equal(
      (await request(url.replace(session.id, "wrong-token"))).status,
      404,
    );
    c.devices.clear();
    assert.equal((await request(url)).status, 404);
  } finally {
    await audio.stop(false);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("PCM header and sample conversion are valid stereo 48 kHz / 16-bit", () => {
  const h = wavHeader();
  assert.equal(h.toString("ascii", 0, 4), "RIFF");
  assert.equal(h.readUInt32LE(24), 48000);
  assert.equal(h.readUInt16LE(22), 2);
  assert.equal(h.readUInt16LE(34), 16);
  assert.equal(h.readUInt32LE(40), WAV_DATA_SIZE);
  const converted = pcm16(
    Buffer.from(new Float32Array([-2, -1, 0, 1, 2, NaN]).buffer),
  );
  assert.deepEqual(
    Array.from({ length: 6 }, (_, i) => converted.readInt16LE(i * 2)),
    [-32768, -32768, 0, 32767, 32767, 0],
  );
});
test("FLAC round-trips sample-exactly through an independent decoder, including multibyte frame numbers", async () => {
  const encoded = [],
    encoder = new FlacEncoder((chunk) => encoded.push(chunk));
  // Cross 128, 2048 and 4096: short startup tests missed failures after a minute.
  const samples = new Float32Array(BLOCK_FRAMES * 2 * 8200);
  for (let i = 0; i < samples.length; i++)
    samples[i] = i % 7 === 0 ? 0 : Math.sin(i * 0.017) * 0.87;
  samples[0] = -1;
  samples[1] = 1;
  samples[2] = 1 / 8388608;
  encoder.push(Buffer.from(samples.buffer));
  const flac = Buffer.concat(encoded),
    packed = flac.readBigUInt64BE(18);
  assert.equal(Number(packed >> 44n), 48000);
  assert.equal(Number((packed >> 41n) & 7n) + 1, 2);
  assert.equal(Number((packed >> 36n) & 31n) + 1, 24);
  const child = spawn(
      ffmpeg,
      [
        "-v",
        "error",
        "-i",
        "pipe:0",
        "-f",
        "s24le",
        "-c:a",
        "pcm_s24le",
        "pipe:1",
      ],
      { windowsHide: true },
    ),
    parts = [];
  let error = "";
  child.stdout.on("data", (b) => parts.push(b));
  child.stderr.on("data", (b) => (error += b));
  const done = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(error)),
    );
  });
  child.stdin.end(flac);
  await done;
  assert.equal(error, "");
  const decoded = Buffer.concat(parts);
  assert.equal(decoded.length, samples.length * 3);
  for (let i = 0; i < samples.length; i++)
    assert.equal(decoded.readIntLE(i * 3, 3), quantize24(samples[i]));
});
test("Audio sessions reject stale packets", async () => {
  const c = {
    devices: new Map(),
    baseUrl: "http://192.168.1.2:12345",
    requireRoom() {},
    emitState() {},
    log() {},
  };
  const audio = new DesktopAudio(c),
    session = audio.prepare(["A"], "pcm16");
  audio.push("stale", new Float32Array(1920).buffer);
  assert.equal(audio.session.frames, 0);
  for (let i = 0; i < 100; i++)
    audio.push(session.id, new Float32Array(1920).buffer, 0.2);
  assert.equal(audio.session.frames, 96000);
  assert.equal(audio.snapshot().level, 0.2);
  await audio.stop(false);
  assert.equal(audio.snapshot().active, false);
});

test(
  "New and reconnected listeners receive only live audio, without replaying old capture",
  { timeout: 5000 },
  async () => {
    const c = {
      devices: new Map([["A", { host: "127.0.0.1" }]]),
      requireRoom() {},
      emitState() {},
      log() {},
    };
    const audio = new DesktopAudio(c);
    const server = http.createServer((req, res) => audio.handle(req, res));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    c.baseUrl = `http://127.0.0.1:${server.address().port}`;
    try {
      for (const format of ["pcm16", "flac24"]) {
        const { id } = audio.prepare(["A"], format);
        for (let attempt = 0; attempt < 2; attempt++) {
          // Material captured before the listener arrives must never be replayed.
          for (let i = 0; i < 30; i++)
            audio.push(id, new Float32Array(512).fill(-0.75).buffer);
          const fresh = new Float32Array(BLOCK_FRAMES * 2).fill(0.25);
          const expectedParts = [];
          if (format === "pcm16")
            expectedParts.push(wavHeader(), pcm16(Buffer.from(fresh.buffer)));
          else
            new FlacEncoder((b) => expectedParts.push(b)).push(
              Buffer.from(fresh.buffer),
            );
          const expected = Buffer.concat(expectedParts);
          await new Promise((resolve, reject) => {
            const request = http.get(audio.session.url, (response) => {
              const parts = [];
              let bytes = 0;
              response.on("error", reject);
              response.on("data", (chunk) => {
                parts.push(chunk);
                bytes += chunk.length;
                if (bytes >= expected.length) {
                  try {
                    assert.deepEqual(Buffer.concat(parts), expected);
                  } catch (error) {
                    reject(error);
                  }
                  response.destroy();
                  resolve();
                }
              });
              audio.push(id, fresh.buffer);
            });
            request.on("error", reject);
          });
          // Reconnect within the same session, without retaining its encoder queue.
          for (const client of [...audio.clients]) audio.drop(client);
        }
        await audio.stop(false);
      }
    } finally {
      await audio.stop(false);
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  },
);
