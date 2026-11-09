// Read-only speaker discovery. No pairing, playback, grouping or configuration changes.
// Usage: node scripts/discover-speakers.mjs --interface 192.168.1.2 --scan-prefix 192.168.1
import dgram from "node:dgram";
import net from "node:net";
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const option = (name) =>
  args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const local = option("--interface");
const prefix = option("--scan-prefix");
if (!local || !net.isIPv4(local))
  throw new Error("Supply --interface with your LAN IPv4 address.");
if (prefix && (!net.isIPv4(`${prefix}.1`) || !local.startsWith(`${prefix}.`))) {
  throw new Error(
    "--scan-prefix must be the /24 prefix of the selected LAN interface.",
  );
}
const network = Object.values(os.networkInterfaces())
  .flat()
  .find((x) => x?.address === local);
if (!network || network.internal)
  throw new Error("The interface must exist and be external.");
if (prefix && network.netmask !== "255.255.255.0")
  throw new Error("Subnet probing supports /24 only.");
const outDir = path.resolve(
  "diagnostics",
  new Date().toISOString().replace(/[:.]/g, "-"),
);
await fs.mkdir(outDir, { recursive: true });
const result = {
  timestamp: new Date().toISOString(),
  local,
  network,
  ssdp: [],
  probes: [],
  devices: [],
};

async function discover() {
  const socket = dgram.createSocket("udp4");
  const seen = new Set();
  let firstSearchAt;
  socket.on("message", (data, remote) => {
    const headers = Object.fromEntries(
      data
        .toString()
        .split("\r\n")
        .slice(1)
        .filter((x) => x.includes(":"))
        .map((x) => {
          const i = x.indexOf(":");
          return [x.slice(0, i).toLowerCase(), x.slice(i + 1).trim()];
        }),
    );
    if (!headers.location || seen.has(headers.location)) return;
    seen.add(headers.location);
    result.ssdp.push({
      address: remote.address,
      discoveryElapsedMs:
        firstSearchAt === undefined
          ? null
          : +(performance.now() - firstSearchAt).toFixed(2),
      ...headers,
    });
  });
  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(0, local, resolve);
  });
  socket.setMulticastInterface(local);
  socket.setMulticastTTL(2);
  const search = (target) =>
    socket.send(
      Buffer.from(
        `M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${target}\r\n\r\n`,
      ),
      1900,
      "239.255.255.250",
    );
  firstSearchAt = performance.now();
  search("urn:schemas-upnp-org:device:ZonePlayer:1");
  await new Promise((resolve) => setTimeout(resolve, 3000));
  search("urn:schemas-upnp-org:device:ZonePlayer:1");
  await new Promise((resolve) => setTimeout(resolve, 4000));
  socket.close();
}

async function probe(host) {
  return new Promise((resolve) => {
    const start = performance.now();
    const socket = new net.Socket();
    let done = false;
    const finish = (status) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({
        host,
        port: 1400,
        status,
        ms: +(performance.now() - start).toFixed(2),
      });
    };
    socket.setTimeout(1500, () => finish("timeout"));
    socket.once("error", (err) => finish(err.code));
    socket.connect({ host, port: 1400, localAddress: local }, () =>
      finish("open"),
    );
  });
}

async function scan() {
  if (!prefix) return;
  const hosts = Array.from(
    { length: 254 },
    (_, i) => `${prefix}.${i + 1}`,
  ).filter((x) => x !== local);
  let index = 0;
  await Promise.all(
    Array.from({ length: 24 }, async () => {
      while (index < hosts.length)
        result.probes.push(await probe(hosts[index++]));
    }),
  );
}

await Promise.all([discover(), scan()]);
const candidates = new Set(
  result.probes
    .filter((x) => x.status === "open")
    .map((x) => `http://${x.host}:1400/xml/device_description.xml`),
);
for (const item of result.ssdp) {
  try {
    const url = new URL(item.location);
    if (
      url.protocol === "http:" &&
      url.hostname === item.address &&
      url.port === "1400"
    )
      candidates.add(url.href);
  } catch {}
}
for (const url of candidates) {
  try {
    const start = performance.now();
    const response = await fetch(url, {
      signal: AbortSignal.timeout(4000),
      redirect: "error",
    });
    const xml = await response.text();
    if (!xml.includes("Sonos")) {
      result.devices.push({ url, status: response.status, sonos: false });
      continue;
    }
    const field = (name) =>
      xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`))?.[1] ??
      null;
    const file = `${new URL(url).hostname}-device.xml`;
    await fs.writeFile(path.join(outDir, file), xml);
    result.devices.push({
      url,
      status: response.status,
      sonos: true,
      ms: +(performance.now() - start).toFixed(2),
      room: field("roomName"),
      model: field("modelName"),
      version: field("softwareVersion"),
      udn: field("UDN"),
      file,
    });
  } catch (error) {
    result.devices.push({ url, error: error.message });
  }
}
await fs.writeFile(
  path.join(outDir, "discovery.json"),
  JSON.stringify(result, null, 2),
);
console.log(
  JSON.stringify(
    {
      outDir,
      ssdpResponses: result.ssdp.length,
      discoveryResponses: result.ssdp.map((x) => ({
        address: x.address,
        elapsedMs: x.discoveryElapsedMs,
      })),
      scanCounts: result.probes.reduce(
        (a, x) => ({ ...a, [x.status]: (a[x.status] || 0) + 1 }),
        {},
      ),
      devices: result.devices,
    },
    null,
    2,
  ),
);
