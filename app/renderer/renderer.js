const $ = (selector) => document.querySelector(selector);
let state = { rooms: [], audio: { active: false } },
  selected = new Set(),
  selectionTouched = false,
  capture = null,
  starting = false,
  noticeTimer;
const cardNodes = new Map(),
  deviceNodes = new Map(),
  volumeTimers = new Map(),
  pendingVolumes = new Map();
const command = (name, args) => window.housecast.command(name, args);
function notify(message, error = false) {
  clearTimeout(noticeTimer);
  $("#notice span").textContent = message;
  $("#notice").classList.toggle("error", error);
  $("#notice").hidden = false;
  noticeTimer = setTimeout(
    () => ($("#notice").hidden = true),
    error ? 11000 : 4500,
  );
}
async function action(fn) {
  try {
    return await fn();
  } catch (error) {
    notify(error.message, true);
  }
}
function showView(view) {
  for (const v of ["listen", "connection"]) $(`#${v}-view`).hidden = v !== view;
  document.querySelectorAll(".nav-item").forEach((b) => {
    b.classList.toggle("active", b.dataset.view === view);
    if (b.dataset.view === view) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
  $("#page-title").textContent =
    view === "listen" ? "Your listening space" : "System settings";
  $("#page-subtitle").textContent =
    view === "listen"
      ? "Choose your rooms. Bring your sound along."
      : "Your speakers, your network, all in one place.";
  if (view === "connection") void action(() => command("inventory"));
}
document
  .querySelectorAll("[data-view]")
  .forEach((b) => b.addEventListener("click", () => showView(b.dataset.view)));
$(".brand").addEventListener("click", (e) => {
  e.preventDefault();
  showView("listen");
});
$("#empty-connection").addEventListener("click", () => showView("connection"));
$("#notice button").addEventListener(
  "click",
  () => ($("#notice").hidden = true),
);
$("#refresh").addEventListener("click", () => action(() => command("refresh")));
$("#search-speakers").addEventListener("click", () =>
  action(async () => {
    const result = await command("search");
    if (result.discovery?.phase === "error")
      throw new Error(result.discovery.note);
    notify(
      `Search complete. ${result.discovery?.found || 0} speakers responded.`,
    );
  }),
);
$("#auto-discovery").addEventListener("change", () =>
  action(async () => {
    try {
      await command("autoDiscovery", { enabled: $("#auto-discovery").checked });
    } finally {
      render(await command("state"));
    }
  }),
);
$("#select-all").addEventListener("click", () => {
  selectionTouched = true;
  const online = state.rooms.filter((r) => r.online);
  selected = new Set(
    online.every((r) => selected.has(r.id)) ? [] : online.map((r) => r.id),
  );
  render(state);
});
$("#group").addEventListener("click", () =>
  action(async () => {
    await command("group", { ids: [...selected] });
    notify("The selected rooms are grouped.");
  }),
);
$("#ungroup").addEventListener("click", () =>
  action(async () => {
    await command("ungroup");
    notify("Each room can now play separately.");
  }),
);
$("#bluetooth").addEventListener("click", () =>
  action(async () => {
    await command("bluetooth", {
      ids: state.rooms.filter((r) => r.online).map((r) => r.id),
    });
    await releaseCapture();
    notify("Bluetooth is shared. Playback follows the connected device.");
  }),
);
$("#network").addEventListener("change", (event) =>
  action(() => command("network", { address: event.target.value })),
);
$("#add-address").addEventListener("click", () =>
  action(() =>
    command("addAddress", { address: $("#manual-ip").value.trim() }),
  ),
);
$("#export").addEventListener("click", () =>
  action(async () => {
    const result = await command("export");
    if (result.saved) notify("Connection report saved.");
  }),
);
$("#firewall").addEventListener("click", () =>
  action(async () => {
    notify(
      "Approve the Windows prompt to allow connections from your home subnet.",
    );
    await command("firewall");
    notify("Home speaker connections are allowed.");
  }),
);
$("#format").value = localStorage.getItem("format") || "flac24";
$("#local-mute").checked = localStorage.getItem("localMute") === "true";
$("#format").addEventListener("change", () =>
  localStorage.setItem("format", $("#format").value),
);
$("#local-mute").addEventListener("change", () =>
  localStorage.setItem("localMute", String($("#local-mute").checked)),
);
function makeCard(room) {
  const node = $("#room-template").content.firstElementChild.cloneNode(true);
  node.dataset.room = room.id;
  node.querySelector(".room-select").addEventListener("click", () => {
    if (state.audio.active || starting) return;
    selectionTouched = true;
    selected.has(room.id) ? selected.delete(room.id) : selected.add(room.id);
    render(state);
  });
  const slider = node.querySelector(".volume-slider");
  slider.addEventListener("input", () => {
    const value = +slider.value;
    pendingVolumes.set(room.id, value);
    node.querySelector("output").textContent = value;
    node.querySelector("output").classList.add("pending");
    clearTimeout(volumeTimers.get(room.id));
    volumeTimers.set(
      room.id,
      setTimeout(
        () =>
          action(async () => {
            try {
              await command("volume", { id: room.id, volume: value });
            } finally {
              if (pendingVolumes.get(room.id) === value)
                pendingVolumes.delete(room.id);
              render(state);
            }
          }),
        110,
      ),
    );
  });
  node.querySelector(".room-mute").addEventListener("click", () =>
    action(() =>
      command("mute", {
        id: room.id,
        mute: !state.rooms.find((r) => r.id === room.id)?.mute,
      }),
    ),
  );
  node.querySelector(".room-play").addEventListener("click", () =>
    action(() => {
      const current = state.rooms.find((r) => r.id === room.id);
      if (current?.source?.kind === "desktop-ended")
        return startCapture(current.groupMembers);
      return command("transport", {
        id: room.id,
        action:
          state.rooms.find((r) => r.id === room.id)?.state === "PLAYING"
            ? "Pause"
            : "Play",
      });
    }),
  );
  return node;
}
function render(next) {
  state = next;
  const active = !!state.audio.active,
    locked = active || starting || state.busy;
  if (!selectionTouched && !active)
    selected = new Set(state.rooms.filter((r) => r.online).map((r) => r.id));
  for (const id of [...selected])
    if (!state.rooms.some((r) => r.id === id)) selected.delete(id);
  for (const [id, node] of cardNodes)
    if (!state.rooms.some((r) => r.id === id)) {
      node.remove();
      cardNodes.delete(id);
    }
  for (const room of state.rooms) {
    let node = cardNodes.get(room.id);
    if (!node) {
      node = makeCard(room);
      cardNodes.set(room.id, node);
      $("#rooms").append(node);
    }
    node.style.order = state.rooms.indexOf(room);
    const q = (selector) => node.querySelector(selector),
      isSelected = selected.has(room.id);
    node.classList.toggle("selected", isSelected);
    node.classList.toggle("offline", !room.online);
    node.classList.toggle("is-soundbar", !!room.soundbar);
    q(".room-name").textContent = room.name;
    q(".room-model").textContent = room.model || "Speaker";
    q(".room-select").disabled = locked || !room.online;
    q(".room-select").setAttribute("aria-pressed", String(isSelected));
    q(".room-select").setAttribute("aria-label", `Select ${room.name}`);
    q(".room-online span").textContent = room.online
      ? "Connected"
      : room.checked
        ? "Offline"
        : "Checking";
    q(".room-online .dot").classList.toggle("dim", !room.online);
    q(".room-source-name").textContent =
      room.source?.title || "Reading source…";
    q(".room-source-name").title = room.source?.title || "";
    q(".room-state").textContent = !room.online
      ? room.checked
        ? "Waiting for connection"
        : "Reading speaker state"
      : {
          PLAYING: "Playing",
          PAUSED_PLAYBACK: "Paused",
          STOPPED: "Stopped",
          TRANSITIONING: "Switching source…",
        }[room.state] || "Ready";
    const play = q(".room-play");
    play.textContent = room.state === "PLAYING" ? "Ⅱ" : "▶";
    play.disabled = !room.online || state.busy || active;
    play.setAttribute(
      "aria-label",
      `${room.state === "PLAYING" ? "Pause" : "Resume"} ${room.name}${room.groupMembers.length > 1 ? " group" : ""}`,
    );
    const value = pendingVolumes.get(room.id) ?? room.volume;
    q(".volume-slider").value = value;
    q(".volume-slider").disabled = !room.online;
    q(".volume-slider").setAttribute("aria-label", `${room.name} volume`);
    q("output").textContent = value;
    q("output").classList.toggle("pending", pendingVolumes.has(room.id));
    q(".room-mute").disabled = !room.online;
    q(".room-mute").classList.toggle("is-muted", room.mute);
    q(".room-mute").setAttribute(
      "aria-label",
      `${room.mute ? "Unmute" : "Mute"} ${room.name}`,
    );
    q(".room-mute").setAttribute("aria-pressed", String(room.mute));
    q(".room-bonded").textContent = !room.topologyKnown
      ? "Reading room setup…"
      : room.children.length
        ? `${room.children.length} bonded speakers · stay together`
        : "Single speaker";
    q(".room-group").textContent =
      room.groupMembers.length > 1 ? "Grouped" : "Independent";
  }
  const online = state.rooms.filter((r) => r.online),
    chosen = online.filter((r) => selected.has(r.id));
  $("#room-count").textContent = state.rooms.length;
  $("#empty-state").hidden = state.rooms.length > 0;
  if (!state.rooms.length) {
    $("#empty-state h3").textContent = state.discovering
      ? "Finding your speakers"
      : "No rooms found yet";
    $("#empty-state p").textContent = state.discovering
      ? "Looking for speakers on your local network."
      : "Check the selected network, refresh, or add a speaker by IP.";
  }
  $("#network-summary").textContent = state.network
    ? `${online.length} of ${state.rooms.length} rooms connected · ${state.network.name}`
    : "No home network selected";
  $("#selection-summary").textContent =
    chosen.length === 0
      ? "Select a room to begin"
      : chosen.length === 1
        ? `${chosen[0].name} selected`
        : `${chosen.length} rooms selected · ${chosen.map((r) => r.name).join(" + ")}`;
  $("#select-all").textContent =
    online.length > 0 && online.every((r) => selected.has(r.id))
      ? "Clear selection"
      : "Select all";
  $("#select-all").disabled = locked || !online.length;
  $("#group").disabled = locked || chosen.length < 2;
  $("#ungroup").disabled =
    locked || !state.rooms.some((r) => r.groupMembers.length > 1);
  $("#bluetooth").disabled = state.busy || starting || online.length < 2;
  $("#refresh").disabled = state.discovering || state.busy;
  $("#format").disabled = locked;
  $("#local-mute").disabled = locked;
  const button = $("#stream");
  button.disabled = state.busy || starting || (!active && !chosen.length);
  button.classList.toggle("stopping", active);
  $("#stream-text").textContent = starting
    ? "Starting…"
    : active
      ? "Stop streaming"
      : "Stream desktop";
  $("#stream-icon").textContent = active ? "■" : "▶";
  $("#stream-badge").textContent = active
    ? {
        capturing: "CAPTURING",
        connecting: "CONNECTING",
        streaming:
          {
            silent: "NO PC AUDIO",
            muted: "ROOMS MUTED",
            "not-playing": "NOT PLAYING",
            disconnected: "DISCONNECTED",
            "capture-stalled": "CAPTURE STALLED",
          }[state.audio.health?.code] || "LIVE",
        stopping: "STOPPING",
      }[state.audio.phase] || "ACTIVE"
    : "READY";
  $("#stream-badge").classList.toggle(
    "live",
    state.audio.phase === "streaming" &&
      (!state.audio.health || state.audio.health.code === "receiving"),
  );
  $("#stream-health").hidden = !active && !state.audio.error;
  $("#stream-health").textContent =
    state.audio.error || state.audio.health?.message || "";
  $("#reconnect-audio").hidden =
    !active || !["streaming"].includes(state.audio.phase);
  $("#reconnect-audio").disabled = state.busy || starting;
  $("#stream-detail").textContent = active
    ? `${state.audio.format === "flac24" ? "24-bit FLAC" : "16-bit PCM"} · 48 kHz · ${state.audio.clients} speaker connection${state.audio.clients === 1 ? "" : "s"}`
    : "Stereo audio · stays on your local network";
  $("#stream-time").textContent = active
    ? `${Math.floor(state.audio.seconds / 60)}:${String(Math.floor(state.audio.seconds % 60)).padStart(2, "0")}`
    : "";
  const level = active
    ? Math.max(
        0,
        Math.min(
          12,
          Math.ceil((20 * Math.log10(state.audio.level || 0.0001) + 60) / 5),
        ),
      )
    : 0;
  $("#level-meter")
    .querySelectorAll("i")
    .forEach((el, i) => el.classList.toggle("lit", i < level));
  if (state.appVersion) $("#app-version").textContent = state.appVersion;
  $("#connection-dot").classList.toggle("dim", !online.length);
  $(".app-local .dot").classList.toggle("dim", !online.length);
  $("#connection-status").textContent = state.busy
    ? `${state.operation?.label || "Working"}…`
    : online.length
      ? `${online.length === state.rooms.length ? "All rooms" : "Some rooms"} connected`
      : "Looking for your system";
  const roundTrips = online.map((r) => r.roundTrip).filter(Number.isFinite);
  $("#latency-summary").textContent = roundTrips.length
    ? `Latest control replies: ${Math.min(...roundTrips).toFixed(0)}–${Math.max(...roundTrips).toFixed(0)} ms`
    : "Waiting for a speaker reply";
  const interfaces = state.interfaces || [],
    network = $("#network"),
    fingerprint = JSON.stringify(interfaces);
  if (network.dataset.options !== fingerprint) {
    network.replaceChildren(
      ...interfaces.map((n) => {
        const option = document.createElement("option");
        option.value = n.address;
        option.textContent = `${n.name} · ${n.address}${n.virtual ? " (virtual adapter)" : ""}`;
        return option;
      }),
    );
    network.dataset.options = fingerprint;
  }
  if (state.network) network.value = state.network.address;
  network.disabled = locked;
  network.disabled ||= !!state.discovery?.active;
  $("#network-detail").textContent = state.network
    ? `Local address ${state.network.address} · ${online.length} responding rooms. ${state.connection?.eventsReceived ? "Live speaker events are reaching this PC." : "Waiting for speaker callbacks; polling keeps controls available."}`
    : "Connect Ethernet or Home Wi-Fi, then refresh to choose an interface.";
  $("#add-address").disabled = locked;
  $("#firewall").disabled = locked || !state.network;
  renderDevices(state);
  const logs = state.logs || [],
    logFingerprint = JSON.stringify(logs);
  if ($("#activity").dataset.entries !== logFingerprint) {
    $("#activity").replaceChildren(
      ...(logs.length
        ? logs
        : [
            {
              at: new Date().toISOString(),
              message: "Waiting for your first action.",
              level: "info",
            },
          ]
      ).map((entry) => {
        const li = document.createElement("li");
        li.className = entry.level;
        const time = document.createElement("time");
        time.textContent = new Date(entry.at).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        });
        const message = document.createElement("span");
        message.textContent = entry.message;
        li.append(time, message);
        return li;
      }),
    );
    $("#activity").dataset.entries = logFingerprint;
  }
  if (capture && !active && !starting) void releaseCapture();
}
function renderDevices(current) {
  const devices = current.devices || [],
    search = current.discovery || {};
  const online = devices.filter((d) => d.online).length;
  $("#device-total").textContent = `${online} / ${devices.length}`;
  $("#system-rooms").textContent = current.rooms.filter((r) => r.online).length;
  $("#system-address").textContent =
    current.network?.address || "Not connected";
  $("#inventory-count").textContent = devices.length;
  $("#inventory-empty").hidden = devices.length > 0;
  $("#callback-status").textContent = current.connection?.eventsReceived
    ? `${current.connection.eventsReceived} speaker events received`
    : "Direct polling is active. Waiting for speaker events.";
  $("#auto-discovery").checked = search.automatic !== false;
  $("#search-speakers").disabled = !!search.active || !current.network;
  $("#search-speakers span").textContent = search.active
    ? "Searching…"
    : "Search now";
  $("#search-status").textContent = search.active
    ? "Searching your network"
    : search.phase === "done"
      ? `${search.found} speakers found`
      : search.phase === "error"
        ? "Search needs attention"
        : "Ready to search";
  const progress = $("#search-progress");
  if (search.active && search.phase !== "scanning")
    progress.removeAttribute("value");
  else
    progress.value = search.total
      ? Math.round((search.scanned / search.total) * 100)
      : search.phase === "done"
        ? 100
        : 0;
  $("#search-detail").textContent = search.active
    ? search.phase === "scanning"
      ? `Checking addresses · ${search.scanned} of ${search.total} · ${search.found} speakers found`
      : "Checking saved speakers and listening for discovery replies…"
    : search.note ||
      (search.finishedAt
        ? `Last search ${new Date(search.finishedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}${search.automatic ? " · Automatic discovery every 30 seconds" : " · Automatic discovery off"}`
        : "Saved speakers reconnect automatically.");
  for (const [id, node] of deviceNodes) {
    if (!devices.some((d) => d.id === id)) {
      node.remove();
      deviceNodes.delete(id);
    }
  }
  for (const [index, d] of devices.entries()) {
    let row = deviceNodes.get(d.id);
    if (!row) {
      row = document.createElement("tr");
      row.dataset.device = d.id;
      row.innerHTML =
        '<td><div class="device-title"><span class="device-icon" aria-hidden="true">◧</span><span><strong class="device-name"></strong><span class="device-id mono"></span></span></div></td><td><span class="device-room"></span><span class="device-role"></span></td><td class="device-ip mono"></td><td class="device-rtt mono"></td><td class="device-firmware mono"></td><td><span class="device-status"><i class="dot"></i><span></span></span></td>';
      deviceNodes.set(d.id, row);
    }
    const q = (s) => row.querySelector(s);
    q(".device-name").textContent = d.model || "Speaker";
    q(".device-id").textContent = `ID …${d.id.slice(-9)}`;
    q(".device-id").title = d.id;
    q(".device-room").textContent = d.room || "—";
    q(".device-role").textContent = d.role;
    q(".device-ip").textContent = d.host;
    q(".device-rtt").textContent = Number.isFinite(d.roundTrip)
      ? `${Math.round(d.roundTrip)} ms`
      : "—";
    q(".device-firmware").textContent = d.version || "—";
    const status = q(".device-status");
    status.className = `device-status ${d.online ? "online" : d.checked ? "offline" : "checking"}`;
    status.title = `${d.lastSeen ? `Last successful check: ${new Date(d.lastSeen).toLocaleString()}` : "No successful check this session"}${d.error ? ` · ${d.error}` : ""}`;
    q(".device-status span").textContent = d.online
      ? "Online"
      : d.checked
        ? "Offline"
        : "Checking";
    q(".device-status .dot").classList.toggle("dim", !d.online);
    // Preserve row position and text selection between status updates.
    const list = $("#device-list");
    if (list.children[index] !== row)
      list.insertBefore(row, list.children[index] || null);
  }
}
async function releaseCapture() {
  const previous = capture;
  capture = null;
  if (!previous) return;
  previous.stopping = true;
  previous.node?.disconnect();
  previous.input?.disconnect();
  for (const t of previous.stream?.getTracks() || []) t.stop();
  await previous.context?.close().catch(() => {});
}
async function startCapture(ids = [...selected]) {
  starting = true;
  render(state);
  let prepared;
  try {
    prepared = await command("prepare", {
      ids,
      format: $("#format").value,
      localMute: $("#local-mute").checked,
    });
    const stream = await navigator.mediaDevices.getDisplayMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 2,
        sampleRate: 48000,
      },
      video: { width: 320, height: 180, frameRate: 1 },
    });
    capture = { stream, stopping: false };
    const report = (message, failed = false) =>
      command("captureReport", { id: prepared.id, message, failed }).catch(
        () => {},
      );
    void report(
      `Opened: ${stream
        .getAudioTracks()
        .map((t) => t.label)
        .join(", ")}`,
    );
    if (!stream.getAudioTracks().length)
      throw new Error(
        "Windows did not provide desktop audio. Check the default playback device.",
      );
    for (const track of stream.getVideoTracks()) track.stop();
    const context = new AudioContext({
      sampleRate: 48000,
      latencyHint: "interactive",
    });
    capture.context = context;
    context.addEventListener("statechange", () => {
      if (!capture?.stopping) void report(`Audio context: ${context.state}`);
    });
    await context.audioWorklet.addModule("./capture-worklet.js");
    const input = context.createMediaStreamSource(
        new MediaStream(stream.getAudioTracks()),
      ),
      // A capture-only worklet is pulled automatically. Connecting it through
      // a zero-gain output makes Chromium switch to its slower silent-output
      // timer after 30 seconds, starving the live speaker stream.
      node = new AudioWorkletNode(context, "desktop-capture", {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount: 2,
        channelCountMode: "explicit",
      });
    capture.input = input;
    capture.node = node;
    input.connect(node);
    await context.resume();
    let firstPacket;
    const first = new Promise((resolve) => (firstPacket = resolve));
    node.port.onmessage = ({ data }) => {
      window.housecast.sendAudio(prepared.id, data.buffer, data.level);
      firstPacket();
    };
    const current = capture;
    for (const event of ["mute", "unmute"])
      stream
        .getAudioTracks()[0]
        .addEventListener(event, () => void report(`Capture track: ${event}`));
    stream.getAudioTracks()[0].addEventListener("ended", () => {
      if (!current.stopping) {
        notify("Desktop capture ended. Restart streaming to reconnect.", true);
        void action(async () => {
          await command("stop");
          await releaseCapture();
        });
      }
    });
    await Promise.race([
      first,
      new Promise((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                "Desktop capture did not start. Check the Windows audio output.",
              ),
            ),
          5000,
        ),
      ),
    ]);
    await command("stream", { id: prepared.id });
  } catch (error) {
    if (prepared)
      await command("captureReport", {
        id: prepared.id,
        message: error.message,
        failed: true,
      }).catch(() => {});
    await command("stop").catch(() => {});
    await releaseCapture();
    throw error;
  } finally {
    starting = false;
    render(state);
  }
}
$("#stream").addEventListener("click", () =>
  action(async () => {
    if (state.audio.active) {
      const result = await command("stop");
      await releaseCapture();
      notify(
        result.restored
          ? "Streaming stopped. Previous sources and rooms restored."
          : "Desktop capture stopped.",
      );
    } else await startCapture();
  }),
);
window.housecast.onState(render);
$("#reconnect-audio").addEventListener("click", () =>
  action(async () => {
    const ids = [...state.audio.targets];
    await command("stop");
    await releaseCapture();
    await startCapture(ids);
  }),
);
action(async () => render(await command("state")));
