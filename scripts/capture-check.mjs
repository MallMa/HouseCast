// Read Windows loopback samples without setting any speaker source or volume.
import { _electron as electron } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";
const app = await electron.launch({
  args: ["."],
  env: {
    ...process.env,
    HOUSECAST_TEST_DATA: path.join(process.env.APPDATA, "Housecast"),
  },
  timeout: 45000,
});
let page;
try {
  page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].hide(),
  );
  await page.waitForFunction(
    () => document.querySelectorAll(".room-card:not(.offline)").length > 0,
    null,
    { timeout: 30000 },
  );
  const result = await page.evaluate(async () => {
    const states = [];
    let stream, ctx, prepared;
    const start = performance.now();
    const mark = (step, extra = {}) =>
      states.push({
        step,
        ms: Math.round(performance.now() - start),
        ...extra,
      });
    try {
      const s = await window.housecast.command("state");
      prepared = await window.housecast.command("prepare", {
        ids: [s.rooms[0].id],
        format: "flac24",
        localMute: false,
      });
      mark("prepared");
      stream = await navigator.mediaDevices.getDisplayMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
        video: true,
      });
      mark("captured", {
        tracks: stream.getTracks().map((t) => ({
          kind: t.kind,
          label: t.label,
          state: t.readyState,
          muted: t.muted,
        })),
      });
      stream.getVideoTracks().forEach((t) => t.stop());
      ctx = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
      mark("context", { state: ctx.state });
      await ctx.audioWorklet.addModule("./capture-worklet.js");
      mark("worklet");
      const input = ctx.createMediaStreamSource(
        new MediaStream(stream.getAudioTracks()),
      );
      const node = new AudioWorkletNode(ctx, "desktop-capture", {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount: 2,
        channelCountMode: "explicit",
      });
      let packets = 0,
        peak = 0;
      node.port.onmessage = ({ data }) => {
        packets++;
        peak = Math.max(peak, data.level);
        window.housecast.sendAudio(prepared.id, data.buffer, data.level);
      };
      input.connect(node);
      await ctx.resume();
      mark("resumed", { state: ctx.state });
      await new Promise((r) => setTimeout(r, 5000));
      mark("measured", { packets, peak, state: ctx.state });
    } catch (error) {
      mark("error", { error: error.message });
    } finally {
      stream?.getTracks().forEach((t) => t.stop());
      await ctx?.close();
      await window.housecast.command("stop");
    }
    return states;
  });
  console.log(JSON.stringify(result, null, 2));
  await fs.writeFile(
    "test-output/capture-only.json",
    JSON.stringify(result, null, 2),
  );
} finally {
  await app.close();
}
