// Temporary, read-only event subscriptions. No playback/settings commands.
// Usage: node scripts/test-speaker-events.mjs <speaker-ip> <this-pc-ip>
import http from "node:http";
import net from "node:net";
import os from "node:os";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
const [speaker, local] = process.argv.slice(2);
const network = Object.values(os.networkInterfaces())
  .flat()
  .find((x) => x.address === local && !x.internal);
if (
  !net.isIPv4(speaker ?? "") ||
  !network ||
  !net.isIPv4(local ?? "") ||
  network.netmask !== "255.255.255.0" ||
  speaker.split(".").slice(0, 3).join(".") !==
    local.split(".").slice(0, 3).join(".")
)
  throw new Error("Supply a speaker and local address on the same local /24.");
const description = await fetch(
  `http://${speaker}:1400/xml/device_description.xml`,
  { signal: AbortSignal.timeout(3000), redirect: "error" },
).then((x) => x.text());
if (!description.includes("Sonos"))
  throw new Error("Endpoint did not identify as Sonos.");
const services = [...description.matchAll(/<service>([\s\S]*?)<\/service>/g)]
  .map((m) => ({
    type: m[1].match(/<serviceType>(.*?)<\/serviceType>/)?.[1],
    path: m[1].match(/<eventSubURL>(.*?)<\/eventSubURL>/)?.[1],
  }))
  .filter((x) => /:(ZoneGroupTopology|AVTransport):1$/.test(x.type ?? ""));
if (!services.length) throw new Error("No relevant event services advertised.");
const token = randomUUID(),
  events = [],
  subscriptions = [];
const server = http.createServer((req, res) => {
  const service = services.find(
    (s) => req.url === `/${token}/${s.type.split(":").at(-2)}`,
  );
  if (
    !service ||
    req.method !== "NOTIFY" ||
    req.socket.remoteAddress !== speaker
  ) {
    res.writeHead(404).end();
    req.resume();
    return;
  }
  let bytes = 0;
  req.on("data", (chunk) => {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) req.destroy();
  });
  req.on("end", () => {
    events.push({
      at: new Date().toISOString(),
      service: service.type,
      sequence: req.headers.seq,
      bytes,
    });
    res.writeHead(200).end();
  });
});
server.requestTimeout = 5000;
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, local, resolve);
});
const port = server.address().port;
try {
  for (const service of services) {
    const url = new URL(service.path, `http://${speaker}:1400/`);
    if (
      url.hostname !== speaker ||
      url.protocol !== "http:" ||
      url.port !== "1400"
    )
      throw new Error("Unexpected event URL.");
    const response = await fetch(url, {
      method: "SUBSCRIBE",
      headers: {
        CALLBACK: `<http://${local}:${port}/${token}/${service.type.split(":").at(-2)}>`,
        NT: "upnp:event",
        TIMEOUT: "Second-30",
      },
      signal: AbortSignal.timeout(3000),
      redirect: "error",
    });
    subscriptions.push({
      service: service.type,
      url: url.href,
      status: response.status,
      sid: response.headers.get("sid"),
    });
    await response.text();
  }
  await new Promise((resolve) => setTimeout(resolve, 7000));
} finally {
  for (const sub of subscriptions.filter((x) => x.sid)) {
    try {
      const response = await fetch(sub.url, {
        method: "UNSUBSCRIBE",
        headers: { SID: sub.sid },
        signal: AbortSignal.timeout(3000),
        redirect: "error",
      });
      sub.unsubscribeStatus = response.status;
      await response.text();
    } catch (error) {
      sub.unsubscribeError = error.message;
    }
  }
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  const result = {
    timestamp: new Date().toISOString(),
    speaker,
    local,
    port,
    subscriptions,
    events,
    note: "Temporary initial-event delivery test; not a source-switch or acoustic-latency measurement.",
  };
  await fs.mkdir("diagnostics", { recursive: true });
  const file = `diagnostics/events-${speaker}-${Date.now()}.json`;
  await fs.writeFile(file, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ...result, file }, null, 2));
}
