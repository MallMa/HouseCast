// Real Windows capture + speaker soak. Always muted and <=30%, including cleanup.
import { _electron as electron } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";
const option = (name, fallback) =>
  process.argv.find((v) => v.startsWith(`--${name}=`))?.split("=")[1] ||
  fallback;
const seconds = Number(option("seconds", "300"));
const format = option("format", "flac24");
const sink = option("sink", "default");
const graph = option("graph", "production");
const packaged = !process.argv.includes("--dev");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const file = `test-output/soak-${format}-${sink}-${graph}-${stamp}.json`;
const readings = [],
  errors = [];
let app, page, before, prefs, restored;
async function command(method, args = {}) {
  if (method === "volume") args.volume = Math.min(30, args.volume);
  return page.evaluate(
    ({ method, args }) => window.housecast.command(method, args),
    { method, args },
  );
}
async function wait(check, timeout = 40000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const s = await command("state");
    if (check(s)) return s;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("State timeout");
}
try {
  app = await electron.launch({
    ...(packaged
      ? { executablePath: path.resolve("release/win-unpacked/Housecast.exe") }
      : { args: ["."] }),
    env: {
      ...process.env,
      HOUSECAST_TEST_DATA: path.join(process.env.APPDATA, "Housecast"),
    },
    timeout: 45000,
  });
  page = await app.firstWindow();
  await page.evaluate(
    ({ sink, graph }) => {
      const RealContext = window.AudioContext;
      window.__soakContexts = [];
      window.AudioContext = class extends RealContext {
        constructor(options) {
          super({
            ...options,
            ...(sink === "none" ? { sinkId: { type: "none" } } : {}),
          });
          window.__soakContexts.push(this);
        }
      };
      if (graph === "terminal") {
        const RealNode = window.AudioWorkletNode;
        window.AudioWorkletNode = class extends RealNode {
          constructor(context, name, options) {
            super(context, name, {
              ...options,
              numberOfInputs: 1,
              numberOfOutputs: 0,
              channelCount: 2,
              channelCountMode: "explicit",
            });
          }
          connect(destination) {
            return destination;
          }
        };
      }
    },
    { sink, graph },
  );
  page.on("pageerror", (e) => errors.push(e.message));
  before = await wait(
    (s) => s.rooms.length > 0 && s.rooms.every((r) => r.online),
  );
  prefs = await page.evaluate(() => ({
    format: document.querySelector("#format").value,
    localMute: document.querySelector("#local-mute").checked,
  }));
  for (const r of before.rooms) {
    await command("mute", { id: r.id, mute: true });
    await command("volume", { id: r.id, volume: Math.min(30, r.volume) });
  }
  for (const r of before.rooms) {
    const button = page.getByRole("button", {
      name: `Select ${r.name}`,
      exact: true,
    });
    if ((await button.getAttribute("aria-pressed")) !== "true")
      await button.click();
  }
  await page.locator("#format").selectOption(format);
  await page.locator("#local-mute").setChecked(false);
  await page
    .getByRole("button", { name: "Stream desktop", exact: true })
    .click();
  const initial = await wait((s) => s.audio.phase === "streaming");
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].minimize(),
  );
  const started = performance.now();
  while (true) {
    const s = await command("state");
    const context = await page.evaluate(() =>
      window.__soakContexts.map((c) => ({
        state: c.state,
        time: c.currentTime,
        sink: c.sinkId,
        sampleRate: c.sampleRate,
        baseLatency: c.baseLatency,
        outputLatency: c.outputLatency,
      })),
    );
    const row = {
      elapsed: Math.round(performance.now() - started),
      audio: s.audio,
      context,
      rooms: s.rooms.map(({ name, state, volume, mute, source }) => ({
        name,
        state,
        volume,
        mute,
        source: source.kind,
      })),
    };
    readings.push(row);
    console.log(JSON.stringify(row));
    if (s.rooms.some((r) => r.volume >= 40 || !r.mute))
      throw new Error("Speaker settings changed during muted test");
    if (
      !s.audio.active ||
      s.audio.id !== initial.audio.id ||
      s.audio.phase !== "streaming" ||
      s.audio.clients < 1
    )
      throw new Error("Live stream disconnected during soak");
    if (
      s.rooms.some((r) => r.state !== "PLAYING" || r.source.kind !== "desktop")
    )
      throw new Error("Speaker playback/source changed");
    if (row.elapsed >= seconds * 1000) break;
    await new Promise((r) => setTimeout(r, 5000));
  }
  console.log("SOAK PASSED");
} catch (e) {
  errors.push(e.message);
  console.error(e.stack);
  process.exitCode = 1;
} finally {
  if (page && before) {
    await command("stop").catch((e) => errors.push("Stop: " + e.message));
    const stopped = await command("state").catch(() => null);
    if (stopped?.audio.active) errors.push("Stream still active after stop");
    restored = stopped?.rooms.map(({ name, state, source, groupMembers }) => ({
      name,
      state,
      source: source.kind,
      groupMembers,
    }));
    for (const r of stopped?.rooms || []) {
      const previous = before.rooms.find((p) => p.id === r.id);
      if (
        r.source.kind !==
          (previous.source.kind === "desktop-ended"
            ? "idle"
            : previous.source.kind) ||
        JSON.stringify([...r.groupMembers].sort()) !==
          JSON.stringify([...previous.groupMembers].sort())
      )
        errors.push(`Source/group not restored for ${r.name}`);
    }
    for (const r of before.rooms) {
      await command("volume", {
        id: r.id,
        volume: Math.min(30, r.volume),
      }).catch(() => {});
      await command("mute", { id: r.id, mute: r.mute }).catch(() => {});
    }
    if (prefs) {
      await page
        .locator("#format")
        .selectOption(prefs.format)
        .catch(() => {});
      await page
        .locator("#local-mute")
        .setChecked(prefs.localMute)
        .catch(() => {});
    }
  }
  await fs.mkdir("test-output", { recursive: true });
  await fs.writeFile(
    file,
    JSON.stringify(
      { seconds, format, sink, graph, errors, restored, readings },
      null,
      2,
    ),
  );
  console.log(file);
  await app?.close();
  if (errors.length) process.exitCode = 1;
}
