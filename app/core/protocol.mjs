import { XMLParser } from "fast-xml-parser";
import net from "node:net";
import os from "node:os";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  processEntities: true,
});
export function xml(text) {
  if (
    typeof text !== "string" ||
    text.length > 2_000_000 ||
    /<!DOCTYPE|<!ENTITY/i.test(text)
  )
    throw new Error("Invalid device response.");
  return parser.parse(text);
}
export const array = (value) =>
  value == null ? [] : Array.isArray(value) ? value : [value];
export const escapeXml = (value) =>
  String(value ?? "").replace(
    /[<>&"']/g,
    (c) =>
      ({
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        '"': "&quot;",
        "'": "&apos;",
      })[c],
  );
export function envelope(type, action, args = {}) {
  return `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${type}">${Object.entries(
    args,
  )
    .map(([k, v]) => `<${k}>${escapeXml(v)}</${k}>`)
    .join("")}</u:${action}></s:Body></s:Envelope>`;
}
export function soapData(text) {
  const body = xml(text)?.Envelope?.Body;
  if (!body) throw new Error("Speaker returned an invalid response.");
  if (body.Fault) {
    const code = body.Fault.detail?.UPnPError?.errorCode ?? "unknown";
    const error = new Error(
      `Speaker refused the command (${code}). ${body.Fault.detail?.UPnPError?.errorDescription || ""}`.trim(),
    );
    error.code = String(code);
    throw error;
  }
  return (
    Object.entries(body).find(
      ([k]) => !k.startsWith("@") && k !== "#text",
    )?.[1] ?? {}
  );
}
export function describe(text, host) {
  const root = xml(text)?.root?.device;
  if (
    !root ||
    !String(root.manufacturer).includes("Sonos") ||
    !String(root.UDN).startsWith("uuid:RINCON_")
  )
    throw new Error("This address does not identify as a compatible speaker.");
  const services = {};
  function walk(device) {
    for (const s of array(device.serviceList?.service)) {
      const name = s.serviceType.split(":").at(-2);
      for (const p of [s.controlURL, s.eventSubURL])
        if (!String(p).startsWith("/") || String(p).startsWith("//"))
          throw new Error("Unexpected speaker service path.");
      services[name] = {
        type: s.serviceType,
        control: s.controlURL,
        event: s.eventSubURL,
      };
    }
    for (const child of array(device.deviceList?.device)) walk(child);
  }
  walk(root);
  return {
    id: root.UDN.replace("uuid:", ""),
    host,
    name: root.roomName || root.friendlyName,
    model: root.modelName,
    version: root.softwareVersion,
    services,
    hidden: !services.AVTransport,
  };
}
export function topology(text) {
  const data = xml(text)?.ZoneGroupState;
  const groups = [],
    members = [];
  for (const g of array(data?.ZoneGroups?.ZoneGroup)) {
    const ids = [];
    for (const m of array(g.ZoneGroupMember)) {
      const entry = {
        id: m["@UUID"],
        name: m["@ZoneName"],
        host: new URL(m["@Location"]).hostname,
        hidden: m["@Invisible"] === "1",
        coordinator: g["@Coordinator"],
        children: array(m.Satellite).map((x) => x["@UUID"]),
      };
      members.push(entry);
      if (!entry.hidden) ids.push(entry.id);
      for (const sat of array(m.Satellite))
        members.push({
          id: sat["@UUID"],
          name: sat["@ZoneName"],
          host: new URL(sat["@Location"]).hostname,
          hidden: true,
          coordinator: entry.id,
          children: [],
        });
    }
    if (ids.length) groups.push({ coordinator: g["@Coordinator"], ids });
  }
  return { groups, members };
}
// DIDL item id that marks streams created by this app, so an ended stream left
// on a speaker is recognized instead of being restored as a playable source.
export const STREAM_ITEM_ID = "housecast";
// Soundbars/home-theater players are preferred as group coordinators so their
// TV input and bonded surrounds keep working while grouped.
export function isHomeTheater(room) {
  return (
    !!room?.services?.HTControl ||
    /\b(Arc|Beam|Ray|Playbar|Playbase)\b/.test(room?.model || "")
  );
}
export function isDesktopStream(uri = "", metadata = "", localAddress) {
  try {
    const u = new URL(uri);
    return (
      u.protocol === "http:" &&
      isPrivate(u.hostname) &&
      (!localAddress || u.hostname === localAddress) &&
      /^\/audio\/[a-f0-9-]{36}\/desktop\.(flac|wav)$/.test(u.pathname) &&
      xml(metadata)?.["DIDL-Lite"]?.item?.["@id"] === STREAM_ITEM_ID
    );
  } catch {
    return false;
  }
}
export function sourceInfo(
  uri = "",
  metadata = "",
  desktopUri = "",
  localAddress,
) {
  let title = "",
    kind = "music";
  try {
    const item = xml(metadata)?.["DIDL-Lite"]?.item;
    title = item?.title || "";
    if (String(item?.class).includes("bluetooth")) kind = "bluetooth";
  } catch {}
  if (desktopUri && uri === desktopUri)
    return { kind: "desktop", title: "Desktop audio" };
  if (isDesktopStream(uri, metadata, localAddress))
    return {
      kind: "desktop-ended",
      title: "Previous desktop stream · start a new stream",
    };
  if (kind === "bluetooth" || /bluetooth/i.test(uri))
    return { kind: "bluetooth", title: "Bluetooth" };
  if (uri.startsWith("x-sonos-htastream:"))
    return { kind: "tv", title: "TV / HDMI" };
  if (uri.startsWith("x-rincon-stream:"))
    return { kind: "linein", title: "Line-in" };
  if (uri.startsWith("x-rincon:"))
    return { kind: "group", title: "Grouped audio" };
  if (!uri) return { kind: "idle", title: "No source selected" };
  return { kind, title: title || "Network audio" };
}
export function isPrivate(ip) {
  return (
    net.isIPv4(ip) &&
    (/^10\./.test(ip) ||
      /^192\.168\./.test(ip) ||
      (ip.startsWith("172.") &&
        +ip.split(".")[1] >= 16 &&
        +ip.split(".")[1] <= 31))
  );
}
const number = (ip) =>
  ip.split(".").reduce((v, octet) => ((v << 8) | +octet) >>> 0, 0);
export function sameSubnet(a, b, mask) {
  return (
    net.isIPv4(a) &&
    net.isIPv4(b) &&
    net.isIPv4(mask) &&
    (number(a) & number(mask)) === (number(b) & number(mask))
  );
}
export function interfaces() {
  return Object.entries(os.networkInterfaces())
    .flatMap(([name, entries]) =>
      entries
        .filter(
          (x) => x.family === "IPv4" && !x.internal && isPrivate(x.address),
        )
        .map((x) => ({
          name,
          address: x.address,
          netmask: x.netmask,
          virtual:
            /tailscale|vethernet|wsl|hyper-v|virtual|docker|vmware|vpn/i.test(
              name,
            ),
        })),
    )
    .sort(
      (a, b) =>
        Number(a.virtual) - Number(b.virtual) ||
        Number(!/ethernet/i.test(a.name)) - Number(!/ethernet/i.test(b.name)),
    );
}
export function streamMetadata(url, format) {
  const mime = format === "flac24" ? "audio/flac" : "audio/wav";
  return `<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"><item id="${STREAM_ITEM_ID}" parentID="0" restricted="true"><dc:title>Desktop audio · Housecast</dc:title><upnp:class>object.item.audioItem.audioBroadcast</upnp:class><res protocolInfo="http-get:*:${mime}:*">${escapeXml(url)}</res></item></DIDL-Lite>`;
}
