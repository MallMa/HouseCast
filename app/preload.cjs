const { contextBridge, ipcRenderer } = require("electron");
const methods = new Set([
  "state",
  "refresh",
  "search",
  "autoDiscovery",
  "inventory",
  "volume",
  "mute",
  "transport",
  "group",
  "ungroup",
  "bluetooth",
  "prepare",
  "captureReport",
  "stream",
  "stop",
  "network",
  "addAddress",
  "export",
  "firewall",
]);
contextBridge.exposeInMainWorld("housecast", {
  command: async (method, args = {}) => {
    if (!methods.has(method)) throw new Error("Unknown command.");
    const result = await ipcRenderer.invoke("housecast:command", method, args);
    if (result?.error) throw new Error(result.error);
    return result;
  },
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("housecast:state", listener);
    return () => ipcRenderer.removeListener("housecast:state", listener);
  },
  sendAudio: (id, buffer, level) =>
    ipcRenderer.send("housecast:audio", id, buffer, level),
});
