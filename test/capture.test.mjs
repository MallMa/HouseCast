import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";

// Run the actual processor with the output-less graph used by the renderer.
async function processor() {
  let Capture;
  const packets = [];
  vm.runInNewContext(
    await fs.readFile(
      new URL("../app/renderer/capture-worklet.js", import.meta.url),
      "utf8",
    ),
    {
      AudioWorkletProcessor: class {
        port = { postMessage: (value) => packets.push(value) };
      },
      registerProcessor: (_name, implementation) => {
        Capture = implementation;
      },
      Float32Array,
    },
  );
  return { node: new Capture(), packets };
}

test("Capture-only worklet preserves both channels without a playback output", async () => {
  const { node, packets } = await processor();
  const left = Float32Array.from({ length: 128 }, (_, i) => i / 128);
  const right = Float32Array.from(left, (v) => -v / 2);
  for (let i = 0; i < 2; i++)
    assert.equal(node.process([[left, right]], []), true);
  assert.equal(packets.length, 1);
  const samples = new Float32Array(packets[0].buffer);
  assert.equal(samples.length, 512);
  for (let i = 0; i < 256; i++) {
    assert.equal(samples[i * 2], left[i % 128]);
    assert.equal(samples[i * 2 + 1], right[i % 128] || 0);
  }
  assert.equal(packets[0].level, 127 / 128);
});

test("Capture-only worklet keeps sending silence when there are no input or output channels", async () => {
  const { node, packets } = await processor();
  for (let i = 0; i < 4; i++) assert.equal(node.process([[]], []), true);
  assert.equal(packets.length, 2);
  for (const p of packets) {
    assert.equal(new Float32Array(p.buffer).length, 512);
    assert.ok(new Float32Array(p.buffer).every((v) => v === 0));
    assert.equal(p.level, 0);
  }
});
