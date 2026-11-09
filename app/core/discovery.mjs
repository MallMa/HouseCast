import net from "node:net";
import { isPrivate } from "./protocol.mjs";

const number = (ip) => ip.split(".").reduce((n, p) => ((n << 8) | +p) >>> 0, 0);
const address = (n) =>
  [24, 16, 8, 0].map((shift) => (n >>> shift) & 255).join(".");

export function discoveryTargets(network) {
  if (!network || !isPrivate(network.address) || !net.isIPv4(network.netmask))
    return {
      hosts: [],
      note: "Select a private home-network interface to search.",
    };
  const mask = number(network.netmask),
    inverse = ~mask >>> 0;
  if ((inverse & (inverse + 1)) !== 0 || inverse > 511)
    return {
      hosts: [],
      note: "This subnet is too large for an address scan. Multicast discovery and saved addresses are still checked.",
    };
  const base = (number(network.address) & mask) >>> 0;
  const hosts = [];
  for (let i = 1; i < inverse; i++) {
    const host = address(base + i);
    if (host !== network.address) hosts.push(host);
  }
  return { hosts, note: "" };
}

export function probePlayerPort(host, localAddress, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false);
    const socket = net.createConnection({ host, port: 1400, localAddress });
    let finished = false;
    const done = (open) => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener("abort", abort);
      socket.destroy();
      resolve(open);
    };
    const abort = () => done(false);
    signal?.addEventListener("abort", abort, { once: true });
    socket.setTimeout(450);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}
