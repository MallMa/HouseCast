import test from "node:test";
import assert from "node:assert/strict";
import {
  topology,
  describe,
  soapData,
  envelope,
  sourceInfo,
  streamMetadata,
  sameSubnet,
  xml,
  isHomeTheater,
  isDesktopStream,
} from "../app/core/protocol.mjs";
import { Controller } from "../app/core/controller.mjs";

test("Expired desktop streams are cleared during restore, never fetched again", async () => {
  const uri =
    "http://192.168.1.2:52677/audio/16c18fe7-b515-4944-a185-7ff3b6fa049e/desktop.flac";
  const metadata = streamMetadata(uri, "flac24");
  assert.equal(sourceInfo(uri, metadata).kind, "desktop-ended");
  assert.equal(sourceInfo(uri, metadata, uri).kind, "desktop");
  const c = new Controller({ dataDir: ".app-test-data" });
  c.rooms.set("A", { id: "A", online: true, uri: "current" });
  c.soap = async () => ({ data: { CurrentURI: "current" } });
  c.refresh = async () => {};
  const calls = [];
  c.setSource = async (...args) => calls.push(args);
  await c.restore(
    {
      groups: [{ coordinator: "A", ids: ["A"] }],
      rooms: [{ id: "A", uri, metadata, state: "PLAYING" }],
    },
    "current",
    "A",
    ["A"],
  );
  assert.deepEqual(calls, [["A", "", "", false]]);
  c.agent.destroy();
});

test("Bluetooth sharing retains Arc as coordinator and keeps its observed session", async () => {
  const c = new Controller({ dataDir: ".app-test-data" });
  c.rooms.set("A", {
    id: "A",
    online: true,
    model: "Sonos Arc Ultra",
    uri: "x-sonos-vli:A:3,bluetooth:session",
    metadata: "",
  });
  c.rooms.set("B", { id: "B", online: true, model: "Sonos Five" });
  c.refreshRoom = async () => {};
  c.refresh = async () => {};
  c.group = async (ids, coordinator) => {
    assert.deepEqual(ids, ["A", "B"]);
    assert.equal(coordinator, "A");
  };
  c.setSource = async () =>
    assert.fail("The current Bluetooth source should remain selected.");
  assert.deepEqual(await c.shareBluetooth(["B"]), { ids: ["A", "B"] });
  c.agent.destroy();
});
test("Missing Bluetooth sessions produce a useful error before changing rooms", async () => {
  const c = new Controller({ dataDir: ".app-test-data" });
  c.rooms.set("A", {
    id: "A",
    online: true,
    model: "Sonos Arc Ultra",
    uri: "",
  });
  c.refreshRoom = async () => {};
  c.group = async () =>
    assert.fail("Do not group when the requested source is unavailable.");
  await assert.rejects(
    c.shareBluetooth(["A"]),
    /Connect your phone or other device to a speaker over Bluetooth/,
  );
  c.agent.destroy();
});

test("Topology updates preserve pending room read results", async () => {
  const c = new Controller({ dataDir: ".app-test-data" }),
    room = {
      id: "RINCON_A",
      name: "Bedroom",
      host: "192.168.1.10",
      online: true,
      uri: "before",
    };
  c.network = { address: "192.168.1.2", netmask: "255.255.255.0" };
  c.rooms.set(room.id, room);
  c.devices.set(room.id, { ...room, services: { ZoneGroupTopology: {} } });
  c.saveCache = () => {};
  c.soap = async () => ({
    data: {
      ZoneGroupState:
        '<ZoneGroupState><ZoneGroups><ZoneGroup Coordinator="RINCON_A"><ZoneGroupMember UUID="RINCON_A" ZoneName="Bedroom" Location="http://192.168.1.10:1400/xml/device_description.xml"/></ZoneGroup></ZoneGroups></ZoneGroupState>',
    },
  });
  await c.refreshTopology();
  assert.equal(c.rooms.get(room.id), room);
  room.uri = "read completed";
  assert.equal(c.rooms.get(room.id).uri, "read completed");
  c.agent.destroy();
});

test("A late old read cannot overwrite a newer confirmed volume or source", async () => {
  const c = new Controller({ dataDir: ".app-test-data" });
  c.rooms.set("A", { id: "A", online: true });
  let release,
    first = true;
  const old = new Promise((resolve) => (release = resolve));
  c.soap = async (_id, _service, action) => {
    const value = first ? 1 : 2;
    if (value === 1) await old;
    return {
      data:
        action === "GetVolume"
          ? { CurrentVolume: String(value) }
          : action === "GetMediaInfo"
            ? { CurrentURI: `source-${value}` }
            : action === "GetMute"
              ? { CurrentMute: "0" }
              : { CurrentTransportState: "PLAYING" },
      ms: 5,
    };
  };
  const previous = c.refreshRoom("A");
  first = false;
  await c.refreshRoom("A");
  release();
  await previous;
  assert.equal(c.rooms.get("A").volume, 2);
  assert.equal(c.rooms.get("A").uri, "source-2");
  c.agent.destroy();
});

test("Topology keeps surrounds and sub hidden while exposing both logical rooms", () => {
  const result = topology(
    '<ZoneGroupState><ZoneGroups><ZoneGroup Coordinator="RINCON_A"><ZoneGroupMember UUID="RINCON_A" ZoneName="Bedroom" Location="http://192.168.1.10:1400/xml/device_description.xml"><Satellite UUID="RINCON_S" ZoneName="Bedroom" Location="http://192.168.1.11:1400/xml/device_description.xml"/></ZoneGroupMember><ZoneGroupMember UUID="RINCON_B" ZoneName="Kitchen" Location="http://192.168.1.12:1400/xml/device_description.xml"/></ZoneGroup></ZoneGroups></ZoneGroupState>',
  );
  assert.deepEqual(result.groups, [
    { coordinator: "RINCON_A", ids: ["RINCON_A", "RINCON_B"] },
  ]);
  assert.equal(result.members.find((m) => m.id === "RINCON_S").hidden, true);
  assert.deepEqual(result.members[0].children, ["RINCON_S"]);
});
test("SOAP protects source metadata and reports speaker faults", () => {
  assert.match(
    envelope("urn:test", "SetURI", { URI: "a&b<c" }),
    /<URI>a&amp;b&lt;c<\/URI>/,
  );
  const response =
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:GetVolumeResponse xmlns:u="urn:test"><CurrentVolume>9</CurrentVolume></u:GetVolumeResponse></s:Body></s:Envelope>';
  assert.equal(soapData(response).CurrentVolume, "9");
  assert.throws(
    () =>
      soapData(
        "<Envelope><Body><Fault><detail><UPnPError><errorCode>701</errorCode></UPnPError></detail></Fault></Body></Envelope>",
      ),
    /701/,
  );
  assert.throws(() => xml("<!DOCTYPE bad><x/>"), /Invalid/);
});
test("Rejects off-network addresses and malicious service paths", () => {
  assert.equal(
    sameSubnet("192.168.1.88", "192.168.1.2", "255.255.255.0"),
    true,
  );
  assert.equal(
    sameSubnet("192.168.68.88", "192.168.1.2", "255.255.255.0"),
    false,
  );
  assert.equal(
    sameSubnet("example.com", "192.168.1.2", "255.255.255.0"),
    false,
  );
  const bad =
    "<root><device><manufacturer>Sonos</manufacturer><UDN>uuid:RINCON_A</UDN><serviceList><service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>//external/control</controlURL><eventSubURL>/events</eventSubURL></service></serviceList></device></root>";
  assert.throws(() => describe(bad, "192.168.1.10"), /Unexpected/);
});
test("Bluetooth session is recognized by DIDL metadata, not a guessed source URI", () => {
  assert.equal(
    sourceInfo(
      "x-sonos-vli:RINCON_A:3,opaque",
      '<DIDL-Lite><item><upnp:class xmlns:upnp="urn:upnp">object.item.audioItem.linein.bluetooth</upnp:class></item></DIDL-Lite>',
    ).kind,
    "bluetooth",
  );
  assert.equal(
    sourceInfo("http://local/session", "", "http://local/session").kind,
    "desktop",
  );
});
test("Grouping keeps Arc coordinator and never sends commands to satellites", async () => {
  const c = new Controller({ dataDir: ".app-test-data" });
  c.rooms = new Map([
    ["A", { id: "A", model: "Sonos Arc Ultra", online: true }],
    ["B", { id: "B", model: "Sonos Five", online: true }],
  ]);
  c.groups = [
    { coordinator: "A", ids: ["A"] },
    { coordinator: "B", ids: ["B"] },
  ];
  const calls = [];
  c.refreshTopology = async () => {};
  c.refresh = async () => {};
  c.soap = async (id, service, action, args) => {
    calls.push({ id, action, args });
    c.groups = [{ coordinator: "A", ids: ["A", "B"] }];
  };
  assert.equal(await c.group(["B", "A"]), "A");
  assert.deepEqual(
    calls.map((x) => x.id),
    ["B"],
  );
  assert.equal(calls[0].args.CurrentURI, "x-rincon:A");
  assert.equal(await c.group(["A", "B"]), "A");
  assert.equal(calls.length, 1);
  c.agent.destroy();
});
test("Stopping a stream respects a source selected outside this app", async () => {
  const c = new Controller({ dataDir: ".app-test-data" });
  c.rooms.set("A", { id: "A", online: true, uri: "new-source" });
  c.refreshRoom = async () => {};
  c.soap = async (_id, _service, action) => {
    assert.equal(
      action,
      "GetMediaInfo",
      "Must not overwrite an external source",
    );
    return { data: { CurrentURI: "new-source" } };
  };
  assert.equal(
    await c.restore({ groups: [], rooms: [] }, "our-stream", "A", ["A"]),
    false,
  );
  c.agent.destroy();
});

test("Home-theater detection uses HTControl or soundbar model names", () => {
  assert.equal(isHomeTheater({ model: "Sonos Arc Ultra" }), true);
  assert.equal(isHomeTheater({ model: "Sonos Beam" }), true);
  assert.equal(isHomeTheater({ model: "Sonos Five" }), false);
  assert.equal(isHomeTheater({ model: "Sonos Era 100" }), false);
  assert.equal(
    isHomeTheater({ model: "X", services: { HTControl: {} } }),
    true,
  );
  assert.equal(isHomeTheater(undefined), false);
});
test("Bluetooth sharing works from any Bluetooth-capable room, not only Arc", async () => {
  const c = new Controller({ dataDir: ".app-test-data" });
  c.rooms.set("E", {
    id: "E",
    online: true,
    model: "Sonos Era 100",
    uri: "x-sonos-vli:E:3,bluetooth:session",
    metadata: "",
  });
  c.rooms.set("F", { id: "F", online: true, model: "Sonos Five" });
  c.refreshRoom = async () => {};
  c.refresh = async () => {};
  c.group = async (ids, coordinator) => {
    assert.deepEqual(ids, ["E", "F"]);
    assert.equal(coordinator, "E");
  };
  c.setSource = async () => assert.fail("Source should stay selected.");
  assert.deepEqual(await c.shareBluetooth(["E", "F"]), { ids: ["E", "F"] });
  c.agent.destroy();
});
test("Stream metadata round-trips through desktop-stream detection", () => {
  const url =
    "http://192.168.1.2:52677/audio/16c18fe7-b515-4944-a185-7ff3b6fa049e/desktop.flac";
  assert.equal(
    isDesktopStream(url, streamMetadata(url, "flac24"), "192.168.1.2"),
    true,
  );
  assert.equal(
    isDesktopStream(url, streamMetadata(url, "flac24"), "192.168.1.3"),
    false,
  );
});
