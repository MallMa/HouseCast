import test from "node:test";
import assert from "node:assert/strict";
import { Controller } from "../app/core/controller.mjs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const hosts = { RINCON_A: "192.168.1.10", RINCON_B: "192.168.1.11" };
function description(id) {
  const services = ["AVTransport", "RenderingControl", "ZoneGroupTopology"]
    .map(
      (name) =>
        `<service><serviceType>urn:schemas-upnp-org:service:${name}:1</serviceType><controlURL>/${name}/Control</controlURL><eventSubURL>/${name}/Event</eventSubURL></service>`,
    )
    .join("");
  return `<root><device><manufacturer>Sonos</manufacturer><UDN>uuid:${id}</UDN><roomName>${id}</roomName><modelName>Sonos Five</modelName><serviceList>${services}</serviceList></device></root>`;
}
function controller(ids = ["RINCON_A"]) {
  const c = new Controller({ dataDir: ".app-test-data" });
  c.network = { address: "192.168.1.2", netmask: "255.255.255.0" };
  c.saveCache = () => {};
  for (const id of ids) {
    const d = { id, host: hosts[id], name: id, hidden: false, services: {} };
    c.devices.set(id, d);
    c.rooms.set(id, { ...d, online: false });
  }
  c.request = async (host, url, options) => {
    const id = Object.keys(hosts).find((id) => hosts[id] === host);
    if (url === "/xml/device_description.xml")
      return { status: 200, text: description(id) };
    const action = options.headers.SOAPACTION.match(/#([^\"]+)/)[1];
    const fields = {
      GetVolume: "<CurrentVolume>23</CurrentVolume>",
      GetMute: "<CurrentMute>0</CurrentMute>",
      GetTransportInfo:
        "<CurrentTransportState>STOPPED</CurrentTransportState>",
      GetMediaInfo: "<CurrentURI></CurrentURI>",
      GetZoneGroupState:
        "<ZoneGroupState>&lt;ZoneGroupState&gt;&lt;ZoneGroups/&gt;&lt;/ZoneGroupState&gt;</ZoneGroupState>",
    }[action];
    assert.ok(fields, `Unexpected command: ${action}`);
    return {
      status: 200,
      ms: 1,
      text: `<Envelope><Body><${action}Response>${fields}</${action}Response></Body></Envelope>`,
    };
  };
  return c;
}

test("A cached speaker recovers after its startup description request fails, without multicast", async () => {
  const c = controller(),
    request = c.request;
  let descriptions = 0;
  c.request = async (...args) => {
    if (args[1] === "/xml/device_description.xml" && ++descriptions === 1)
      throw new Error("Network not ready during startup");
    return request(...args);
  };
  try {
    await c.register(hosts.RINCON_A, "RINCON_A");
    assert.equal(c.rooms.get("RINCON_A").online, false);
    await c.refresh();
    assert.equal(c.rooms.get("RINCON_A").online, true);
    assert.equal(descriptions, 2);
    assert.equal(c.rooms.get("RINCON_A").volume, 23);
  } finally {
    await c.close();
  }
});

test(
  "A responsive room becomes online before an unavailable room finishes connecting",
  { timeout: 3000 },
  async () => {
    const c = controller(["RINCON_A", "RINCON_B"]),
      request = c.request;
    let releaseSlow, markReady, timeout;
    const slow = new Promise((resolve) => (releaseSlow = resolve));
    const ready = new Promise((resolve) => (markReady = resolve));
    c.on("state", (s) => {
      if (s.rooms.some((r) => r.id === "RINCON_A" && r.online)) markReady();
    });
    c.request = async (...args) => {
      if (
        args[0] === hosts.RINCON_B &&
        args[1] === "/xml/device_description.xml"
      )
        await slow;
      return request(...args);
    };
    let complete = false;
    const refresh = c.refresh().then(() => {
      complete = true;
    });
    try {
      await Promise.race([
        ready,
        new Promise((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("The fast room waited for the slow room")),
            1000,
          );
        }),
      ]);
      assert.equal(complete, false);
      assert.equal(c.rooms.get("RINCON_B").online, false);
    } finally {
      clearTimeout(timeout);
      releaseSlow();
      await refresh;
      await c.close();
    }
  },
);

test(
  "Startup automatically retries a cached speaker without a refresh click or SSDP response",
  { timeout: 5000 },
  async () => {
    const c = controller(),
      request = c.request;
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), "housecast-reconnect-test-"),
    );
    c.dataDir = dir;
    c.availableInterfaces = [c.network];
    c.startServer = async () => {};
    c.discover = async () => {};
    let descriptions = 0,
      markReady,
      timer;
    const ready = new Promise((resolve) => (markReady = resolve));
    c.on("state", (s) => {
      if (s.rooms.some((r) => r.online)) markReady();
    });
    c.request = async (...args) => {
      if (args[1] === "/xml/device_description.xml" && ++descriptions === 1)
        throw new Error("Network not ready during startup");
      return request(...args);
    };
    const file = path.join(dir, "rooms.json");
    try {
      await fs.writeFile(
        file,
        JSON.stringify({
          interfaceAddress: c.network.address,
          devices: [...c.devices.values()],
        }),
      );
      await c.start();
      await Promise.race([
        ready,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Automatic retry never connected")),
            3500,
          );
        }),
      ]);
      assert.equal(descriptions, 2);
      await c.refresh();
      assert.equal(
        descriptions,
        2,
        "Healthy rooms should not repeatedly fetch their descriptions",
      );
    } finally {
      clearTimeout(timer);
      await c.close();
      await fs.unlink(file);
      await fs.rmdir(dir);
    }
  },
);
