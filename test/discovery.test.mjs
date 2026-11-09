import test from "node:test";
import assert from "node:assert/strict";
import { discoveryTargets } from "../app/core/discovery.mjs";
import { Controller } from "../app/core/controller.mjs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("Address discovery stays inside a bounded private subnet and skips this PC", () => {
  const { hosts, note } = discoveryTargets({
    address: "192.168.1.2",
    netmask: "255.255.255.0",
  });
  assert.equal(note, "");
  assert.equal(hosts.length, 253);
  assert.ok(!hosts.includes("192.168.1.2"));
  assert.equal(hosts[0], "192.168.1.1");
  assert.equal(hosts.at(-1), "192.168.1.254");
  assert.equal(
    discoveryTargets({ address: "192.168.1.2", netmask: "255.255.0.0" }).hosts
      .length,
    0,
  );
  assert.equal(
    discoveryTargets({ address: "8.8.8.8", netmask: "255.255.255.0" }).hosts
      .length,
    0,
  );
  assert.equal(
    discoveryTargets({ address: "192.168.1.2", netmask: "255.0.255.0" }).hosts
      .length,
    0,
  );
});

test("Inventory includes a bonded speaker with its own health without turning it into a room", async () => {
  const c = new Controller({ dataDir: ".app-test-data" });
  c.network = { address: "192.168.1.2", netmask: "255.255.255.0" };
  c.saveCache = () => {};
  c.rooms.set("RINCON_A", {
    id: "RINCON_A",
    name: "Bedroom",
    online: true,
    children: ["RINCON_S"],
  });
  c.devices.set("RINCON_S", {
    id: "RINCON_S",
    name: "Bedroom",
    host: "192.168.1.17",
    hidden: true,
  });
  c.request = async () => ({
    status: 200,
    ms: 7.6,
    text: "<root><device><manufacturer>Sonos</manufacturer><UDN>uuid:RINCON_S</UDN><roomName>Bedroom</roomName><modelName>Sonos Era 300</modelName><softwareVersion>94.1-76070</softwareVersion><serviceList><service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>/control</controlURL><eventSubURL>/events</eventSubURL></service></serviceList></device></root>",
  });
  try {
    await c.refreshInventory();
    const s = c.snapshot();
    assert.equal(s.rooms.length, 1);
    assert.equal(s.devices.length, 1);
    assert.equal(s.devices[0].hidden, true);
    assert.equal(s.devices[0].room, "Bedroom");
    assert.equal(s.devices[0].online, true);
    assert.equal(s.devices[0].roundTrip, 7.6);
    assert.equal(s.devices[0].version, "94.1-76070");
    assert.ok(s.devices[0].lastSeen);
    c.request = async () => {
      throw new Error("No reply");
    };
    await c.refreshInventory();
    assert.equal(c.snapshot().devices[0].online, false);
    assert.equal(
      c.snapshot().rooms[0].online,
      true,
      "A bonded speaker's failed health read must not mark its parent offline",
    );
    assert.equal(c.snapshot().devices[0].error, "No reply");
  } finally {
    await c.close();
  }
});

test("Automatic discovery can be disabled without disabling saved-room refresh", async () => {
  const c = new Controller({ dataDir: ".app-test-data" });
  let saved = 0,
    searched = 0;
  c.saveCache = () => saved++;
  c.searchDevices = async () => searched++;
  try {
    c.setAutoDiscovery(false);
    assert.equal(c.snapshot().discovery.automatic, false);
    assert.equal(searched, 0);
    c.setAutoDiscovery(true);
    assert.equal(c.snapshot().discovery.automatic, true);
    assert.equal(searched, 1);
    assert.equal(saved, 2);
    assert.throws(() => c.setAutoDiscovery("yes"), /Invalid/);
  } finally {
    await c.close();
  }
});

test("The automatic discovery preference survives an app restart", async () => {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "housecast-discovery-test-"),
  );
  const writer = new Controller({ dataDir: dir });
  const reader = new Controller({ dataDir: dir });
  reader.startServer = async () => {};
  let searches = 0;
  reader.searchDevices = async () => searches++;
  try {
    writer.setAutoDiscovery(false);
    const file = path.join(dir, "rooms.json");
    for (let i = 0; i < 30; i++) {
      if (await fs.stat(file).catch(() => false)) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await reader.start();
    assert.equal(reader.autoDiscovery, false);
    assert.equal(searches, 0);
  } finally {
    await writer.close();
    await reader.close();
    await fs.unlink(path.join(dir, "rooms.json"));
    await fs.unlink(path.join(dir, "stream-diagnostics.jsonl")).catch(() => {});
    await fs.rmdir(dir);
  }
});
