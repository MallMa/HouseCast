// Read-only mDNS queries; legacy-unicast replies are requested on an ephemeral port.
import dgram from "node:dgram";
import net from "node:net";
import os from "node:os";
import fs from "node:fs/promises";
const local = process.argv[2];
if (
  !net.isIPv4(local ?? "") ||
  !Object.values(os.networkInterfaces())
    .flat()
    .some((x) => x.address === local && !x.internal)
)
  throw new Error("Pass a local LAN IPv4 address.");
const names = ["_sonos._tcp.local", "_sonos._udp.local", "_airplay._tcp.local"];
function encodeName(name) {
  return Buffer.concat([
    ...name
      .split(".")
      .map((label) =>
        Buffer.concat([
          Buffer.from([Buffer.byteLength(label)]),
          Buffer.from(label),
        ]),
      ),
    Buffer.from([0]),
  ]);
}
function decodeName(data, offset, visited = new Set()) {
  const parts = [];
  let end = offset;
  while (offset < data.length) {
    if (visited.has(offset)) throw new Error("DNS name cycle");
    visited.add(offset);
    const length = data[offset++];
    if (!length) {
      end = offset;
      break;
    }
    if ((length & 0xc0) === 0xc0) {
      if (offset >= data.length) throw new Error("Truncated pointer");
      const pointer = ((length & 0x3f) << 8) | data[offset++];
      parts.push(decodeName(data, pointer, visited).name);
      end = offset;
      break;
    }
    if (offset + length > data.length) throw new Error("Truncated label");
    parts.push(data.subarray(offset, offset + length).toString());
    offset += length;
    end = offset;
  }
  return { name: parts.join("."), end };
}
const records = [],
  errors = [];
const socket = dgram.createSocket("udp4");
socket.on("error", (e) => errors.push(e.message));
socket.on("message", (data, remote) => {
  try {
    if (data.length < 12) return;
    let offset = 12;
    for (let q = 0; q < data.readUInt16BE(4); q++)
      offset = decodeName(data, offset).end + 4;
    const count =
      data.readUInt16BE(6) + data.readUInt16BE(8) + data.readUInt16BE(10);
    for (let r = 0; r < count; r++) {
      const decoded = decodeName(data, offset);
      offset = decoded.end;
      if (offset + 10 > data.length) throw new Error("Truncated record");
      const type = data.readUInt16BE(offset),
        length = data.readUInt16BE(offset + 8);
      offset += 10;
      if (offset + length > data.length) throw new Error("Truncated value");
      let value;
      if (type === 12 || type === 5) value = decodeName(data, offset).name;
      else if (type === 1 && length === 4)
        value = [...data.subarray(offset, offset + length)].join(".");
      else if (type === 33 && length >= 6)
        value = {
          port: data.readUInt16BE(offset + 4),
          target: decodeName(data, offset + 6).name,
        };
      else if (type === 16)
        value = data
          .subarray(offset, offset + length)
          .toString()
          .replace(/[\x00-\x1f]/g, " ");
      else value = data.subarray(offset, offset + length).toString("hex");
      records.push({ from: remote.address, name: decoded.name, type, value });
      offset += length;
    }
  } catch (e) {
    errors.push(e.message);
  }
});
await new Promise((resolve, reject) => {
  socket.once("error", reject);
  socket.bind(0, local, resolve);
});
socket.setMulticastInterface(local);
socket.setMulticastTTL(255);
for (const name of names) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(1, 4);
  const question = Buffer.from([0, 12, 0, 1]);
  socket.send(
    Buffer.concat([header, encodeName(name), question]),
    5353,
    "224.0.0.251",
  );
}
await new Promise((resolve) => setTimeout(resolve, 6000));
socket.close();
await fs.mkdir("diagnostics", { recursive: true });
await fs.writeFile(
  "diagnostics/mdns.json",
  JSON.stringify(
    { timestamp: new Date().toISOString(), local, names, records, errors },
    null,
    2,
  ),
);
console.log(JSON.stringify({ records, errors }, null, 2));
