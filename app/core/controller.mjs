import http from "node:http";
import dgram from "node:dgram";
import fs from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { discoveryTargets, probePlayerPort } from "./discovery.mjs";
import { Diagnostics } from "./diagnostics.mjs";
import {
  describe,
  envelope,
  soapData,
  topology,
  sourceInfo,
  isDesktopStream,
  interfaces,
  sameSubnet,
  isHomeTheater,
} from "./protocol.mjs";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
export class Controller extends EventEmitter {
  constructor({ dataDir, appVersion = null }) {
    super();
    this.dataDir = dataDir;
    this.appVersion = appVersion;
    this.diagnostics = new Diagnostics(dataDir);
    this.devices = new Map();
    this.rooms = new Map();
    this.groups = [];
    this.logs = [];
    this.subscriptions = new Map();
    this.pendingDevices = new Map();
    this.lastDeviceProbe = new Map();
    this.volumeQueues = new Map();
    this.pendingRefresh = null;
    this.discovering = false;
    this.busy = false;
    this.closing = false;
    this.operation = null;
    this.autoDiscovery = true;
    this.search = {
      active: false,
      phase: "idle",
      scanned: 0,
      total: 0,
      found: 0,
    };
    this.agent = new http.Agent({
      keepAlive: true,
      maxSockets: 12,
      maxFreeSockets: 8,
    });
    this.eventToken = randomUUID();
    this.availableInterfaces = interfaces();
    this.network =
      this.availableInterfaces.find((x) => !x.virtual) ||
      this.availableInterfaces[0];
  }
  log(message, level = "info") {
    this.diagnostics.write("message", { message, level });
    this.logs.unshift({ at: new Date().toISOString(), message, level });
    this.logs = this.logs.slice(0, 100);
    this.emitState();
  }
  emitState() {
    this.emit("state", this.snapshot());
  }
  snapshot() {
    return {
      appVersion: this.appVersion,
      network: this.network,
      interfaces: this.availableInterfaces,
      discovering: this.discovering,
      discovery: { ...this.search, automatic: this.autoDiscovery },
      devices: [...this.devices.values()]
        .map((d) => {
          const room =
            this.rooms.get(d.id) ||
            [...this.rooms.values()].find((r) => r.children?.includes(d.id));
          const ownRoom = !d.hidden && this.rooms.get(d.id);
          return {
            id: d.id,
            name: d.name,
            model: d.model,
            host: d.host,
            room: room?.name || d.name || "Unassigned",
            hidden: !!d.hidden,
            role: d.hidden
              ? /Sub/i.test(d.model)
                ? "Subwoofer"
                : "Bonded speaker"
              : "Room speaker",
            online: ownRoom
              ? !!ownRoom.online
              : !!d.online && Date.now() - (d.lastSeen || 0) < 90000,
            checked: ownRoom ? !!ownRoom.checked : !!d.checked,
            roundTrip: ownRoom?.roundTrip ?? d.roundTrip,
            lastSeen: Math.max(ownRoom?.lastSeen || 0, d.lastSeen || 0) || null,
            version: d.version || null,
            error: ownRoom?.error || d.error || null,
          };
        })
        .sort(
          (a, b) =>
            a.room.localeCompare(b.room) ||
            Number(a.hidden) - Number(b.hidden) ||
            a.model?.localeCompare(b.model),
        ),
      busy: this.busy,
      operation: this.operation,
      connection: {
        eventsReceived: this.eventsReceived || 0,
        lastEventAt: this.lastEventAt || null,
      },
      rooms: [...this.rooms.values()]
        .filter((r) => !r.hidden)
        .map((r) => {
          const coordinator = this.rooms.get(r.coordinator) || r;
          return {
            id: r.id,
            name: r.name,
            model: r.model,
            soundbar: isHomeTheater(r),
            host: r.host,
            online: r.online || false,
            checked: r.checked || false,
            volume: r.volume ?? 0,
            mute: !!r.mute,
            state: coordinator.state || "UNKNOWN",
            source: sourceInfo(
              coordinator.uri,
              coordinator.metadata,
              this.audio?.session?.url,
              this.network?.address,
            ),
            coordinator: r.coordinator || r.id,
            groupMembers: this.groups.find((g) => g.ids.includes(r.id))
              ?.ids || [r.id],
            children: (r.children || []).map(
              (id) => this.devices.get(id)?.model || "Bonded speaker",
            ),
            roundTrip: r.roundTrip,
            topologyKnown: this.groups.some((g) => g.ids.includes(r.id)),
            lastSeen: r.lastSeen,
            error: r.error,
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name)),
      logs: this.logs.slice(0, 40),
      audio: this.audio?.snapshot() || { active: false },
    };
  }
  async start() {
    await fs.mkdir(this.dataDir, { recursive: true });
    this.diagnostics.write("startup", { network: this.network });
    try {
      const cache = JSON.parse(
        await fs.readFile(path.join(this.dataDir, "rooms.json"), "utf8"),
      );
      this.autoDiscovery = cache.autoDiscovery !== false;
      this.network =
        this.availableInterfaces.find(
          (x) => x.address === cache.interfaceAddress,
        ) || this.network;
      for (const d of cache.devices || [])
        if (d.id?.startsWith("RINCON_") && this.allowed(d.host)) {
          this.devices.set(d.id, { ...d, services: {} });
          if (!d.hidden)
            this.rooms.set(d.id, {
              ...d,
              online: false,
              checked: false,
              coordinator: d.id,
            });
        }
    } catch {}
    this.emitState();
    this.pollTimer = setInterval(() => {
      if (this.busy) return;
      const connected =
        this.rooms.size && [...this.rooms.values()].every((r) => r.online);
      // Recover quickly while a known room is offline. Healthy rooms retain the
      // normal four-second poll interval; pendingRefresh prevents overlap.
      if (!connected || Date.now() - (this.lastRefreshAt || 0) >= 4000)
        void this.refresh();
    }, 1000);
    this.discoveryTimer = setInterval(() => {
      if (this.autoDiscovery) {
        void this.searchDevices({
          // Periodically look beyond saved addresses even when all known rooms
          // are online: multicast may be blocked when a new speaker is added.
          deep: Date.now() - (this.lastSweep || 0) > 120000,
        });
      } else void this.refreshInventory();
    }, 30000);
    this.renewTimer = setInterval(() => void this.subscribeAll(), 40000);
    if (!this.network) {
      this.log(
        "No home-network connection found. Connect Ethernet or Wi-Fi and refresh.",
        "error",
      );
      return;
    }
    await this.startServer();
    void this.refresh();
    if (this.autoDiscovery)
      void this.searchDevices({ deep: !this.devices.size });
    else void this.refreshInventory();
  }
  allowed(host) {
    return (
      !!this.network &&
      sameSubnet(host, this.network.address, this.network.netmask)
    );
  }
  async startServer() {
    this.server = http.createServer((req, res) => {
      if (this.audio?.handle(req, res)) return;
      const peer = req.socket.remoteAddress;
      const match = req.url?.match(
        new RegExp(
          `^/events/${this.eventToken}/(RINCON_[A-Z0-9]+)/([A-Za-z]+)$`,
        ),
      );
      const device = match && this.devices.get(match[1]);
      if (req.method !== "NOTIFY" || !device || peer !== device.host) {
        res.writeHead(404).end();
        req.resume();
        return;
      }
      let size = 0;
      req.on("data", (chunk) => {
        size += chunk.length;
        if (size > 1_000_000) req.destroy();
      });
      req.on("end", () => {
        res.writeHead(200).end();
        this.eventsReceived = (this.eventsReceived || 0) + 1;
        this.lastEventAt = Date.now();
        const sub = this.subscriptions.get(`${device.id}/${match[2]}`);
        if (sub) sub.notified = true;
        clearTimeout(this.eventRefreshTimer);
        this.eventRefreshTimer = setTimeout(() => void this.refresh(), 70);
      });
    });
    this.server.requestTimeout = 5000;
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, this.network.address, resolve);
    });
    this.port = this.server.address().port;
  }
  get baseUrl() {
    return `http://${this.network.address}:${this.port}`;
  }
  request(
    host,
    servicePath,
    { method = "GET", headers = {}, body = "", timeout = 2000 } = {},
  ) {
    if (
      !this.allowed(host) ||
      !servicePath.startsWith("/") ||
      servicePath.startsWith("//")
    )
      return Promise.reject(
        new Error("Speaker address is outside the selected home network."),
      );
    return new Promise((resolve, reject) => {
      const started = performance.now();
      let settled = false;
      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        err ? reject(err) : resolve(value);
      };
      const req = http.request(
        {
          host,
          port: 1400,
          path: servicePath,
          method,
          headers,
          agent: this.agent,
          localAddress: this.network.address,
        },
        (res) => {
          let bytes = 0,
            parts = [];
          res.on("data", (chunk) => {
            bytes += chunk.length;
            if (bytes > 2_000_000) {
              req.destroy(new Error("Speaker response was too large."));
              return;
            }
            parts.push(chunk);
          });
          res.on("end", () =>
            finish(null, {
              status: res.statusCode,
              headers: res.headers,
              text: Buffer.concat(parts).toString(),
              ms: performance.now() - started,
            }),
          );
          res.on("error", (err) => finish(err));
        },
      );
      const timer = setTimeout(
        () =>
          req.destroy(new Error(`No reply from ${host} within ${timeout} ms.`)),
        timeout,
      );
      req.on("error", (err) => finish(err));
      req.setNoDelay(true);
      req.end(body);
    });
  }
  async register(host, expectedId) {
    if (!this.allowed(host)) return;
    if (this.pendingDevices.has(host)) return this.pendingDevices.get(host);
    const promise = (async () => {
      try {
        const response = await this.request(
          host,
          "/xml/device_description.xml",
        );
        if (this.closing) return null;
        if (response.status !== 200)
          throw new Error("Device description unavailable.");
        const device = describe(response.text, host);
        if (expectedId && expectedId !== device.id)
          throw new Error(
            "Address now belongs to a different device. Rediscovering.",
          );
        const previous = this.devices.get(device.id);
        // A description does not tell us whether an Era is bonded as a surround.
        // Keep the topology's classification when refreshing its health.
        device.hidden = previous?.hidden ?? device.hidden;
        Object.assign(device, {
          online: true,
          checked: true,
          lastSeen: Date.now(),
          roundTrip: Number.isFinite(response.ms)
            ? +response.ms.toFixed(1)
            : null,
          error: null,
        });
        this.devices.set(device.id, { ...previous, ...device });
        if (!device.hidden)
          this.rooms.set(
            device.id,
            Object.assign(this.rooms.get(device.id) || {}, device, {
              coordinator: this.rooms.get(device.id)?.coordinator || device.id,
              online: this.rooms.get(device.id)?.online || false,
              checked: this.rooms.get(device.id)?.checked || false,
            }),
          );
        this.emitState();
        this.saveCache();
        return device;
      } catch (error) {
        if (expectedId && this.devices.has(expectedId))
          Object.assign(this.devices.get(expectedId), {
            online: false,
            checked: true,
            error: error.message,
          });
        if (expectedId && this.rooms.has(expectedId)) {
          Object.assign(this.rooms.get(expectedId), {
            online: false,
            checked: true,
            error: error.message,
          });
          this.emitState();
        } else this.emitState();
        return null;
      } finally {
        this.pendingDevices.delete(host);
      }
    })();
    this.pendingDevices.set(host, promise);
    return promise;
  }
  async soap(id, service, action, args = {}) {
    const d = this.devices.get(id),
      s = d?.services?.[service];
    if (!s)
      throw new Error(`${d?.name || "Speaker"} does not expose ${service}.`);
    const body = envelope(s.type, action, args);
    const started = performance.now();
    try {
      const response = await this.request(d.host, s.control, {
        method: "POST",
        timeout: action.startsWith("Get") ? 2000 : 6000,
        headers: {
          "Content-Type": 'text/xml; charset="utf-8"',
          SOAPACTION: `"${s.type}#${action}"`,
          "Content-Length": Buffer.byteLength(body),
        },
        body,
      });
      const data = soapData(response.text);
      if (response.status !== 200)
        throw new Error(`Speaker returned HTTP ${response.status}.`);
      if (!action.startsWith("Get") || response.ms > 500)
        this.diagnostics.write("speaker-command", {
          room: d.name,
          host: d.host,
          action,
          ms: +response.ms.toFixed(1),
        });
      return { data, ms: response.ms };
    } catch (error) {
      this.diagnostics.write("speaker-command-failed", {
        room: d.name,
        host: d.host,
        action,
        ms: Math.round(performance.now() - started),
        error: error.message,
      });
      throw error;
    }
  }
  async discover() {
    if (this.discovering || this.closing || !this.network) return;
    this.discovering = true;
    this.emitState();
    const socket = dgram.createSocket("udp4"),
      work = [];
    this.discoverySocket = socket;
    socket.on("message", (data, peer) => {
      if (!this.allowed(peer.address)) return;
      const location = data
        .toString()
        .match(/^location:\s*(.+)$/im)?.[1]
        ?.trim();
      if (!location) return;
      try {
        const u = new URL(location);
        if (
          u.protocol !== "http:" ||
          u.hostname !== peer.address ||
          u.port !== "1400"
        )
          return;
      } catch {
        return;
      }
      work.push(
        this.register(peer.address)
          .then((d) => {
            if (d?.services.AVTransport) return this.refreshRoom(d.id);
          })
          .catch(() => {}),
      );
    });
    try {
      await new Promise((resolve, reject) => {
        socket.once("error", reject);
        socket.bind(0, this.network.address, resolve);
      });
      socket.setMulticastInterface(this.network.address);
      socket.setMulticastTTL(2);
      const message = Buffer.from(
        'M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 1\r\nST: urn:schemas-upnp-org:device:ZonePlayer:1\r\n\r\n',
      );
      socket.send(message, 1900, "239.255.255.250");
      await delay(1700);
      await Promise.allSettled(work);
      await this.refresh();
      void this.subscribeAll();
    } catch (error) {
      if (!this.closing) this.log(`Discovery: ${error.message}`, "error");
    } finally {
      try {
        socket.close();
      } catch {}
      this.discoverySocket = null;
      this.discovering = false;
      this.emitState();
    }
  }
  async refreshInventory() {
    if (this.inventoryWork) return this.inventoryWork;
    this.inventoryWork = Promise.allSettled(
      [...this.devices.values()]
        .filter((d) => this.allowed(d.host))
        .map((d) => this.register(d.host, d.id)),
    ).finally(() => {
      this.inventoryWork = null;
      this.emitState();
    });
    return this.inventoryWork;
  }
  async searchDevices({ deep = true } = {}) {
    if (this.searchWork) {
      const deepInProgress = this.searchDeep;
      await this.searchWork;
      if (deep && !deepInProgress && !this.closing)
        return this.searchDevices({ deep: true });
      return;
    }
    if (this.closing || !this.network) return;
    const network = { ...this.network },
      startedAt = Date.now();
    const abort = new AbortController();
    this.searchAbort = abort;
    this.searchDeep = deep;
    this.search = {
      active: true,
      phase: "discovery",
      scanned: 0,
      total: 0,
      found: 0,
      startedAt,
    };
    this.emitState();
    this.searchWork = (async () => {
      try {
        await Promise.all([this.refreshInventory(), this.discover()]);
        if (deep && !abort.signal.aborted) {
          this.lastSweep = Date.now();
          const { hosts, note } = discoveryTargets(network);
          Object.assign(this.search, {
            phase: "scanning",
            total: hosts.length,
            note,
          });
          this.emitState();
          let next = 0;
          await Promise.all(
            Array.from({ length: Math.min(12, hosts.length) }, async () => {
              while (
                next < hosts.length &&
                !abort.signal.aborted &&
                !this.closing
              ) {
                const host = hosts[next++];
                if (
                  await probePlayerPort(host, network.address, abort.signal)
                ) {
                  if (!abort.signal.aborted) await this.register(host);
                }
                this.search.scanned++;
                this.search.found = [...this.devices.values()].filter(
                  (d) => d.online && d.lastSeen >= startedAt,
                ).length;
                if (this.search.scanned % 8 === 0) this.emitState();
              }
            }),
          );
        }
        if (!abort.signal.aborted && !this.closing) {
          await this.refresh();
          void this.subscribeAll();
        }
        this.search.found = [...this.devices.values()].filter(
          (d) => d.online && d.lastSeen >= startedAt,
        ).length;
        this.search.phase = abort.signal.aborted ? "cancelled" : "done";
      } catch (error) {
        this.search.phase = "error";
        this.search.note = error.message;
        this.log(`Speaker search: ${error.message}`, "error");
      } finally {
        this.search.active = false;
        this.search.finishedAt = Date.now();
        this.searchWork = null;
        this.searchAbort = null;
        this.emitState();
      }
    })();
    return this.searchWork;
  }
  setAutoDiscovery(enabled) {
    if (typeof enabled !== "boolean")
      throw new Error("Invalid discovery setting.");
    this.autoDiscovery = enabled;
    this.saveCache();
    this.emitState();
    if (enabled) void this.searchDevices({ deep: !this.devices.size });
  }
  async refreshTopology() {
    const candidates = [...this.devices.values()]
      .filter((d) => d.services?.ZoneGroupTopology)
      .sort(
        (a, b) =>
          Number(!!this.rooms.get(b.id)?.online) -
            Number(!!this.rooms.get(a.id)?.online) ||
          Number(isHomeTheater(b)) - Number(isHomeTheater(a)),
      );
    let lastError;
    for (const d of candidates.slice(0, 3)) {
      try {
        const { data } = await this.soap(
          d.id,
          "ZoneGroupTopology",
          "GetZoneGroupState",
        );
        const state = topology(data.ZoneGroupState);
        this.groups = state.groups;
        for (const m of state.members) {
          const known = this.devices.get(m.id);
          if (!known || known.host !== m.host) {
            void this.register(m.host, m.id).then(() => this.emitState());
          }
          if (known) Object.assign(known, { hidden: m.hidden });
          if (m.hidden) {
            this.rooms.delete(m.id);
            continue;
          }
          const room = this.rooms.get(m.id) || { ...known };
          Object.assign(room, m, {
            host: this.allowed(m.host) ? m.host : known?.host,
          });
          this.rooms.set(m.id, room);
        }
        this.saveCache();
        return state;
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError) throw lastError;
  }
  async refreshRoom(id) {
    const room = this.rooms.get(id);
    if (!room) return;
    const sequence = (room.readSequence = (room.readSequence || 0) + 1);
    const results = await Promise.allSettled([
      this.soap(id, "RenderingControl", "GetVolume", {
        InstanceID: 0,
        Channel: "Master",
      }),
      this.soap(id, "RenderingControl", "GetMute", {
        InstanceID: 0,
        Channel: "Master",
      }),
      this.soap(id, "AVTransport", "GetTransportInfo", { InstanceID: 0 }),
      this.soap(id, "AVTransport", "GetMediaInfo", { InstanceID: 0 }),
    ]);
    const [vol, mute, transport, media] = results;
    if (room.readSequence !== sequence) return;
    room.checked = true;
    room.online =
      vol.status === "fulfilled" && transport.status === "fulfilled";
    room.error = room.online
      ? null
      : results.find((x) => x.status === "rejected")?.reason?.message;
    if (vol.status === "fulfilled") {
      room.volume = +vol.value.data.CurrentVolume;
      room.roundTrip = +vol.value.ms.toFixed(1);
    }
    if (mute.status === "fulfilled")
      room.mute = mute.value.data.CurrentMute === "1";
    if (transport.status === "fulfilled")
      room.state = transport.value.data.CurrentTransportState;
    if (media.status === "fulfilled") {
      room.uri = media.value.data.CurrentURI || "";
      room.metadata = media.value.data.CurrentURIMetaData || "";
      if (sourceInfo(room.uri, room.metadata).kind === "bluetooth")
        this.lastBluetooth = { id, uri: room.uri, metadata: room.metadata };
    }
    if (room.online) room.lastSeen = Date.now();
    this.emitState();
  }
  async retryKnownDevices(force = false) {
    const now = Date.now();
    const candidates = [...this.devices.values()].filter(
      (d) =>
        !d.hidden &&
        this.allowed(d.host) &&
        (force || !d.services?.AVTransport || !this.rooms.get(d.id)?.online) &&
        (force || now - (this.lastDeviceProbe.get(d.id) || 0) >= 1000),
    );
    await Promise.allSettled(
      candidates.map(async (d) => {
        this.lastDeviceProbe.set(d.id, now);
        const device = await this.register(d.host, d.id);
        // Publish each reachable room immediately, even if another room times out.
        if (!this.closing && device?.services.AVTransport)
          await this.refreshRoom(device.id);
      }),
    );
  }
  async refresh({ forceReconnect = false } = {}) {
    if (this.closing) return;
    if (this.pendingRefresh) {
      await this.pendingRefresh;
      if (forceReconnect && !this.closing)
        return this.refresh({ forceReconnect: true });
      return;
    }
    this.lastRefreshAt = Date.now();
    this.pendingRefresh = (async () => {
      await this.retryKnownDevices(forceReconnect);
      if (this.closing) return;
      try {
        await this.refreshTopology();
      } catch {}
      await Promise.allSettled(
        [...this.rooms.keys()].map((id) => this.refreshRoom(id)),
      );
    })().finally(() => {
      this.pendingRefresh = null;
      this.emitState();
    });
    return this.pendingRefresh;
  }
  saveCache() {
    clearTimeout(this.cacheTimer);
    this.cacheTimer = setTimeout(() => {
      const devices = [...this.devices.values()].map(
        ({ id, host, name, model, hidden }) => ({
          id,
          host,
          name,
          model,
          hidden,
        }),
      );
      void fs
        .writeFile(
          path.join(this.dataDir, "rooms.json"),
          JSON.stringify(
            {
              interfaceAddress: this.network?.address,
              autoDiscovery: this.autoDiscovery,
              devices,
            },
            null,
            2,
          ),
        )
        .catch(() => {});
    }, 200);
  }
  async subscribeAll() {
    if (this.subscriptionWork) return this.subscriptionWork;
    this.subscriptionWork = this.renewSubscriptions().finally(() => {
      this.subscriptionWork = null;
    });
    return this.subscriptionWork;
  }
  async renewSubscriptions() {
    if (this.closing || !this.port) return;
    for (const d of [...this.devices.values()].filter(
      (d) => !d.hidden && d.services.AVTransport,
    )) {
      for (const service of [
        "ZoneGroupTopology",
        "AVTransport",
        "RenderingControl",
      ]) {
        const key = `${d.id}/${service}`,
          old = this.subscriptions.get(key),
          s = d.services[service];
        if (!s) continue;
        if (old?.renewedAt && Date.now() - old.renewedAt < 35000) continue;
        try {
          const headers =
            old?.sid && old.host === d.host
              ? { SID: old.sid, TIMEOUT: "Second-120" }
              : {
                  CALLBACK: `<${this.baseUrl}/events/${this.eventToken}/${d.id}/${service}>`,
                  NT: "upnp:event",
                  TIMEOUT: "Second-120",
                };
          const response = await this.request(d.host, s.event, {
            method: "SUBSCRIBE",
            headers,
          });
          if (response.status !== 200) {
            this.subscriptions.delete(key);
            continue;
          }
          this.subscriptions.set(key, {
            id: d.id,
            host: d.host,
            path: s.event,
            sid: response.headers.sid,
            renewedAt: Date.now(),
            notified: old?.notified || false,
          });
        } catch {
          this.subscriptions.delete(key);
        }
      }
    }
  }
  requireRoom(id) {
    const r = this.rooms.get(id);
    if (!r || !r.online || r.hidden)
      throw new Error(
        "That room is not reachable yet. Refresh the connection and try again.",
      );
    return r;
  }
  async run(label, fn) {
    if (this.busy)
      throw new Error("A source or room change is already in progress.");
    this.busy = true;
    const started = performance.now();
    this.operation = { label, state: "working" };
    this.emitState();
    try {
      const result = await fn();
      this.operation = {
        label,
        state: "done",
        ms: +(performance.now() - started).toFixed(1),
      };
      this.log(label);
      return result;
    } catch (error) {
      this.operation = {
        label,
        state: "error",
        error: error.message,
        ms: +(performance.now() - started).toFixed(1),
      };
      this.log(error.message, "error");
      throw error;
    } finally {
      this.busy = false;
      void this.refresh();
      this.emitState();
    }
  }
  async setVolume(id, volume) {
    this.requireRoom(id);
    if (!Number.isInteger(volume) || volume < 0 || volume > 100)
      throw new Error("Volume must be from 0 to 100.");
    const next = (this.volumeQueues.get(id) || Promise.resolve())
      .catch(() => {})
      .then(async () => {
        await this.soap(id, "RenderingControl", "SetVolume", {
          InstanceID: 0,
          Channel: "Master",
          DesiredVolume: volume,
        });
        await this.refreshRoom(id);
      });
    this.volumeQueues.set(id, next);
    try {
      await next;
    } finally {
      if (this.volumeQueues.get(id) === next) this.volumeQueues.delete(id);
    }
  }
  async setMute(id, mute) {
    this.requireRoom(id);
    await this.soap(id, "RenderingControl", "SetMute", {
      InstanceID: 0,
      Channel: "Master",
      DesiredMute: mute ? 1 : 0,
    });
    await this.refreshRoom(id);
  }
  async transport(id, action) {
    const r = this.requireRoom(id);
    if (!["Play", "Pause", "Stop"].includes(action))
      throw new Error("Unknown playback action.");
    const source = this.rooms.get(r.coordinator) || r;
    if (
      action === "Play" &&
      isDesktopStream(source.uri, source.metadata, this.network?.address) &&
      source.uri !== this.audio?.session?.url
    )
      throw new Error(
        "That desktop stream has ended. Use Stream desktop to open a new capture.",
      );
    await this.soap(r.coordinator || id, "AVTransport", action, {
      InstanceID: 0,
      ...(action === "Play" ? { Speed: 1 } : {}),
    });
    await this.refresh();
  }
  async group(ids, preferredId) {
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > 16 ||
      new Set(ids).size !== ids.length
    )
      throw new Error("Select at least one room.");
    ids.forEach((id) => this.requireRoom(id));
    await this.refreshTopology();
    const coordinator =
      preferredId && ids.includes(preferredId)
        ? preferredId
        : ids.find((id) => isHomeTheater(this.rooms.get(id))) || ids[0];
    const current = this.groups.find((g) => g.ids.includes(coordinator));
    if (
      current &&
      current.coordinator === coordinator &&
      current.ids.length === ids.length &&
      ids.every((id) => current.ids.includes(id))
    )
      return coordinator;
    if (
      current &&
      (current.coordinator !== coordinator ||
        current.ids.some((id) => !ids.includes(id)))
    )
      await this.soap(
        coordinator,
        "AVTransport",
        "BecomeCoordinatorOfStandaloneGroup",
        { InstanceID: 0 },
      );
    if (ids.length > 1 && this.rooms.get(coordinator).uri === "")
      await this.setSource(
        coordinator,
        `x-rincon-queue:${coordinator}#0`,
        "",
        false,
      );
    for (const id of ids.filter((x) => x !== coordinator))
      await this.soap(id, "AVTransport", "SetAVTransportURI", {
        InstanceID: 0,
        CurrentURI: `x-rincon:${coordinator}`,
        CurrentURIMetaData: "",
      });
    const until = Date.now() + 5000;
    do {
      await this.refreshTopology();
      const g = this.groups.find((x) => x.coordinator === coordinator);
      if (
        g &&
        g.ids.length === ids.length &&
        ids.every((id) => g.ids.includes(id))
      ) {
        await this.refresh();
        return coordinator;
      }
      await delay(200);
    } while (Date.now() < until);
    throw new Error(
      "The speakers have not confirmed the requested group. Current room state has been refreshed.",
    );
  }
  async setSource(id, uri, metadata = "", play = true) {
    await this.soap(id, "AVTransport", "SetAVTransportURI", {
      InstanceID: 0,
      CurrentURI: uri,
      CurrentURIMetaData: metadata,
    });
    if (play)
      await this.soap(id, "AVTransport", "Play", { InstanceID: 0, Speed: 1 });
    await this.refreshRoom(id);
  }
  async shareBluetooth(ids) {
    if (!Array.isArray(ids)) throw new Error("Select at least one room.");
    // Any Bluetooth-capable player (Arc, Era, Move, Roam, ...) can be the
    // source. Prefer a room that is playing Bluetooth right now, otherwise the
    // most recently observed Bluetooth session.
    const online = [...this.rooms.values()].filter(
      (r) => r.online && !r.hidden,
    );
    await Promise.allSettled(online.map((r) => this.refreshRoom(r.id)));
    let source = online.find(
      (r) => sourceInfo(r.uri, r.metadata).kind === "bluetooth",
    );
    let bt = source && { uri: source.uri, metadata: source.metadata };
    if (!source && this.lastBluetooth) {
      source = online.find((r) => r.id === this.lastBluetooth.id);
      bt = source && this.lastBluetooth;
    }
    if (!source)
      throw new Error(
        "Connect your phone or other device to a speaker over Bluetooth and start playback. The app can then share that source.",
      );
    const targets = [...new Set([source.id, ...ids])];
    await this.group(targets, source.id);
    if (source.uri !== bt.uri)
      await this.setSource(source.id, bt.uri, bt.metadata, false);
    await this.refresh();
    if (sourceInfo(source.uri, source.metadata).kind !== "bluetooth")
      throw new Error(
        "The Bluetooth session expired. Reconnect your device to the speaker, start playback, and try sharing again.",
      );
    return { ids: targets };
  }
  async captureSnapshot() {
    await this.refreshTopology();
    const groups = structuredClone(this.groups);
    const rooms = await Promise.all(
      [...this.rooms.values()]
        .filter((r) => r.online)
        .map(async (r) => {
          const [media, transport] = await Promise.all([
            this.soap(r.id, "AVTransport", "GetMediaInfo", { InstanceID: 0 }),
            this.soap(r.id, "AVTransport", "GetTransportInfo", {
              InstanceID: 0,
            }),
          ]);
          return {
            id: r.id,
            uri: media.data.CurrentURI || "",
            metadata: media.data.CurrentURIMetaData || "",
            state: transport.data.CurrentTransportState,
          };
        }),
    );
    return {
      groups,
      rooms,
    };
  }
  async restore(snapshot, ownerUri, coordinator, targets) {
    const current = await this.soap(
      coordinator,
      "AVTransport",
      "GetMediaInfo",
      { InstanceID: 0 },
    );
    if (current.data.CurrentURI !== ownerUri) return false;
    try {
      await this.soap(coordinator, "AVTransport", "Stop", { InstanceID: 0 });
    } catch (error) {
      const state = await this.soap(
        coordinator,
        "AVTransport",
        "GetTransportInfo",
        { InstanceID: 0 },
      );
      if (state.data.CurrentTransportState !== "STOPPED") throw error;
    }
    const affected = new Set(targets);
    for (const g of snapshot.groups)
      if (g.ids.some((id) => affected.has(id)))
        g.ids.forEach((id) => affected.add(id));
    // Do not change an unrelated room that acquired another source while we streamed.
    for (const id of affected) {
      const r = this.rooms.get(id);
      if (!r?.online) return false;
      if (
        !targets.includes(id) &&
        r.uri !== snapshot.rooms.find((x) => x.id === id)?.uri
      )
        return false;
    }
    for (const id of affected)
      await this.soap(id, "AVTransport", "BecomeCoordinatorOfStandaloneGroup", {
        InstanceID: 0,
      });
    for (const g of snapshot.groups.filter((g) =>
      g.ids.some((id) => affected.has(id)),
    )) {
      const original = snapshot.rooms.find((r) => r.id === g.coordinator);
      if (original && !original.uri.startsWith("x-rincon:")) {
        // A previous desktop stream has no producer after it is stopped.
        // Restoring its URL makes the speaker wait for a dead HTTP endpoint, and may
        // block later commands even when the requested state was STOPPED.
        const expired = isDesktopStream(
          original.uri,
          original.metadata,
          this.network?.address,
        );
        await this.setSource(
          g.coordinator,
          expired ? "" : original.uri,
          expired ? "" : original.metadata,
          !expired && original.state === "PLAYING",
        );
      }
      for (const id of g.ids.filter((id) => id !== g.coordinator))
        await this.soap(id, "AVTransport", "SetAVTransportURI", {
          InstanceID: 0,
          CurrentURI: `x-rincon:${g.coordinator}`,
          CurrentURIMetaData: "",
        });
    }
    await this.refresh();
    return true;
  }
  async addAddress(host) {
    if (!this.allowed(host))
      throw new Error("Enter a speaker IPv4 address on the selected LAN.");
    const d = await this.register(host);
    if (!d) throw new Error("No compatible speaker replied at that address.");
    await this.refresh();
    void this.subscribeAll();
  }
  async changeInterface(address) {
    if (this.audio?.session)
      throw new Error("Stop desktop audio before changing networks.");
    const chosen = interfaces().find((x) => x.address === address);
    if (!chosen) throw new Error("Network interface is no longer available.");
    await this.closeNetworking();
    this.network = chosen;
    this.availableInterfaces = interfaces();
    this.closing = false;
    this.subscriptions.clear();
    this.lastDeviceProbe.clear();
    for (const r of this.rooms.values()) {
      r.online = false;
      r.checked = false;
    }
    await this.startServer();
    this.saveCache();
    await Promise.all([
      this.refresh({ forceReconnect: true }),
      this.discover(),
    ]);
  }
  async closeSubscriptions() {
    await this.subscriptionWork;
    for (const sub of this.subscriptions.values()) {
      try {
        await this.request(sub.host, sub.path, {
          method: "UNSUBSCRIBE",
          headers: { SID: sub.sid },
          timeout: 700,
        });
      } catch {}
    }
    this.subscriptions.clear();
  }
  async closeNetworking() {
    this.searchAbort?.abort();
    await this.searchWork;
    await this.closeSubscriptions();
    try {
      this.discoverySocket?.close();
    } catch {}
    if (this.server) {
      this.server.closeAllConnections();
      await new Promise((r) => this.server.close(r));
      this.server = null;
    }
  }
  async close() {
    this.closing = true;
    for (const t of [
      this.pollTimer,
      this.discoveryTimer,
      this.renewTimer,
      this.cacheTimer,
      this.eventRefreshTimer,
    ])
      clearTimeout(t);
    await this.closeNetworking();
    this.agent.destroy();
    await this.diagnostics.pending;
  }
}
