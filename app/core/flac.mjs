// RFC 9639: fixed 512-sample blocks and two independent verbatim subframes.
// Verbatim coding preserves 24-bit samples and a steady rate even during silence.
// This avoids long byte-based prebuffers in network players with compressed silence.
// 10.67 ms at 48 kHz. The speaker adds its own buffering after receiving these frames.
export const BLOCK_FRAMES = 512;
const crc8Table = new Uint8Array(256),
  crc16Table = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  let a = i,
    b = i << 8;
  for (let bit = 0; bit < 8; bit++) {
    a = (a << 1) ^ (a & 0x80 ? 0x07 : 0);
    b = (b << 1) ^ (b & 0x8000 ? 0x8005 : 0);
  }
  crc8Table[i] = a;
  crc16Table[i] = b;
}
function crc8(buffer) {
  let n = 0;
  for (const byte of buffer) n = crc8Table[n ^ byte];
  return n;
}
function crc16(buffer) {
  let n = 0;
  for (const byte of buffer)
    n = ((n << 8) ^ crc16Table[(n >>> 8) ^ byte]) & 0xffff;
  return n;
}
function utf8Integer(value) {
  if (value < 128) return Buffer.from([value]);
  let length = 2;
  while (value >= 2 ** (5 * length + 1)) length++;
  if (length > 6) throw new Error("FLAC frame counter exceeded its range.");
  const bytes = Buffer.alloc(length);
  for (let i = length - 1; i > 0; i--) {
    bytes[i] = 0x80 | (value % 64);
    value = Math.floor(value / 64);
  }
  bytes[0] = ((0xff << (8 - length)) & 255) | value;
  return bytes;
}
export function flacHeader() {
  const h = Buffer.alloc(42);
  h.write("fLaC");
  h[4] = 0x80;
  h.writeUIntBE(34, 5, 3);
  h.writeUInt16BE(BLOCK_FRAMES, 8);
  h.writeUInt16BE(BLOCK_FRAMES, 10);
  // Frame size ranges include the variable-length frame counter.
  h.writeUIntBE(BLOCK_FRAMES * 6 + 10, 12, 3);
  h.writeUIntBE(BLOCK_FRAMES * 6 + 15, 15, 3);
  h.writeBigUInt64BE((48000n << 44n) | (1n << 41n) | (23n << 36n), 18);
  return h;
}
export function quantize24(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-8388608, Math.min(8388607, Math.round(value * 8388608)));
}
export function flacFrame(interleaved, frameNumber) {
  if (interleaved.length !== BLOCK_FRAMES * 2)
    throw new Error("Invalid FLAC block length.");
  const header = Buffer.concat([
    Buffer.from([0xff, 0xf8, 0x9a, 0x1c]),
    utf8Integer(frameNumber),
  ]);
  const frame = Buffer.allocUnsafe(
    header.length + 1 + 2 * (1 + BLOCK_FRAMES * 3) + 2,
  );
  header.copy(frame);
  let offset = header.length;
  frame[offset++] = crc8(header);
  for (let channel = 0; channel < 2; channel++) {
    frame[offset++] = 0x02;
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      frame.writeIntBE(quantize24(interleaved[i * 2 + channel]), offset, 3);
      offset += 3;
    }
  }
  frame.writeUInt16BE(crc16(frame.subarray(0, offset)), offset);
  return frame;
}
export class FlacEncoder {
  constructor(write) {
    this.write = write;
    this.samples = new Float32Array(BLOCK_FRAMES * 2);
    this.used = 0;
    this.number = 0;
    write(flacHeader());
  }
  push(buffer) {
    const input = new Float32Array(
      buffer.buffer,
      buffer.byteOffset,
      buffer.length / 4,
    );
    let offset = 0;
    while (offset < input.length) {
      const count = Math.min(
        input.length - offset,
        this.samples.length - this.used,
      );
      this.samples.set(input.subarray(offset, offset + count), this.used);
      this.used += count;
      offset += count;
      if (this.used === this.samples.length) {
        this.write(flacFrame(this.samples, this.number++));
        this.used = 0;
      }
    }
  }
}
