import {
  app,
  BrowserWindow,
  desktopCapturer,
  ipcMain,
  session,
  dialog,
  powerSaveBlocker,
} from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Controller } from "./core/controller.mjs";
import { DesktopAudio } from "./core/audio.mjs";
import { allowHomeNetwork } from "./core/firewall.mjs";
import { interfaces } from "./core/protocol.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const rendererUrl = new URL("./renderer/index.html", import.meta.url).href;
const APP_NAME = "Housecast";
if (!app.isPackaged && process.env.HOUSECAST_TEST_DATA)
  app.setPath("userData", path.resolve(process.env.HOUSECAST_TEST_DATA));
app.setName(APP_NAME);
let window,
  controller,
  audio,
  quitting = false,
  captureUntil = 0,
  localMute = false,
  powerBlocker;
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    window?.restore();
    window?.show();
    window?.focus();
  });
  app
    .whenReady()
    .then(async () => {
      controller = new Controller({
        dataDir: app.getPath("userData"),
        appVersion: app.getVersion(),
      });
      audio = new DesktopAudio(controller);
      window = new BrowserWindow({
        width: 1220,
        height: 900,
        minWidth: 880,
        minHeight: 690,
        backgroundColor: "#f5f6f8",
        title: APP_NAME,
        icon: path.join(directory, "assets", "icon.png"),
        autoHideMenuBar: true,
        show: false,
        webPreferences: {
          preload: path.join(directory, "preload.cjs"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          backgroundThrottling: false,
        },
      });
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", (event, url) => {
        if (url !== rendererUrl) event.preventDefault();
      });
      const trusted = (contents) =>
        contents === window?.webContents && contents.getURL() === rendererUrl;
      session.defaultSession.setPermissionCheckHandler(
        (contents, permission) =>
          trusted(contents) &&
          ["display-capture", "media"].includes(permission) &&
          Date.now() < captureUntil,
      );
      session.defaultSession.setPermissionRequestHandler(
        (contents, permission, callback) =>
          callback(
            trusted(contents) &&
              ["display-capture", "media"].includes(permission) &&
              Date.now() < captureUntil,
          ),
      );
      session.defaultSession.setDisplayMediaRequestHandler(
        async (request, callback) => {
          if (
            request.frame?.url !== rendererUrl ||
            Date.now() > captureUntil ||
            !audio.session
          ) {
            callback({});
            return;
          }
          try {
            const screens = await desktopCapturer.getSources({
              types: ["screen"],
              thumbnailSize: { width: 0, height: 0 },
            });
            if (!screens[0]) throw new Error("No desktop screen is available.");
            callback({
              video: screens[0],
              audio: localMute ? "loopbackWithMute" : "loopback",
            });
            captureUntil = 0;
          } catch (error) {
            controller.log(`Desktop capture: ${error.message}`, "error");
            callback({});
          }
        },
      );
      controller.on("state", (state) => {
        const stream = audio.session,
          coordinator = controller.rooms.get(stream?.coordinator);
        if (
          stream?.phase === "streaming" &&
          !stream.checkingOwnership &&
          !controller.busy &&
          coordinator?.online &&
          coordinator.uri !== stream.url
        ) {
          // Confirm a changed URI with a fresh read: state events during source
          // transitions may briefly contain the preceding transport state.
          stream.checkingOwnership = true;
          void controller
            .soap(stream.coordinator, "AVTransport", "GetMediaInfo", {
              InstanceID: 0,
            })
            .then(async ({ data }) => {
              if (
                audio.session === stream &&
                stream.phase === "streaming" &&
                !controller.busy &&
                data.CurrentURI !== stream.url
              ) {
                await audio.stop(false);
                controller.log(
                  "Another source took over. Desktop capture stopped.",
                );
              }
            })
            .catch((error) => controller.log(error.message, "error"))
            .finally(() => {
              stream.checkingOwnership = false;
            });
        }
        if (window && !window.isDestroyed())
          window.webContents.send("housecast:state", state);
        if (state.audio.active && powerBlocker === undefined)
          powerBlocker = powerSaveBlocker.start("prevent-app-suspension");
        if (!state.audio.active && powerBlocker !== undefined) {
          powerSaveBlocker.stop(powerBlocker);
          powerBlocker = undefined;
        }
      });
      ipcMain.handle("housecast:command", async (event, method, args = {}) => {
        if (
          event.sender !== window.webContents ||
          event.senderFrame?.url !== rendererUrl
        )
          throw new Error("Unknown application frame.");
        if (!args || typeof args !== "object")
          throw new Error("Invalid request.");
        try {
          switch (method) {
            case "state":
              return controller.snapshot();
            case "inventory":
              await controller.refreshInventory();
              return controller.snapshot();
            case "search":
              await controller.searchDevices();
              return controller.snapshot();
            case "autoDiscovery":
              controller.setAutoDiscovery(args.enabled);
              return controller.snapshot();
            case "refresh":
              controller.availableInterfaces = interfaces();
              if (
                !controller.network ||
                !controller.availableInterfaces.some(
                  (n) => n.address === controller.network.address,
                )
              ) {
                const next = controller.availableInterfaces.find(
                  (n) => !n.virtual,
                );
                if (next) await controller.changeInterface(next.address);
              }
              await Promise.all([
                controller.refresh({ forceReconnect: true }),
                controller.discover(),
              ]);
              return controller.snapshot();
            case "volume":
              await controller.setVolume(args.id, args.volume);
              break;
            case "mute":
              if (typeof args.mute !== "boolean")
                throw new Error("Invalid mute state.");
              await controller.setMute(args.id, args.mute);
              break;
            case "transport":
              await controller.run(
                args.action === "Play" ? "Resume playback" : "Pause playback",
                () => controller.transport(args.id, args.action),
              );
              break;
            case "group":
              if (audio.session)
                throw new Error("Stop desktop audio before changing rooms.");
              await controller.run("Group selected rooms", () =>
                controller.group(args.ids),
              );
              break;
            case "ungroup":
              if (audio.session)
                throw new Error("Stop desktop audio before changing rooms.");
              await controller.run("Separate rooms", async () => {
                for (const r of [...controller.rooms.values()].filter(
                  (r) => r.online,
                ))
                  await controller.group([r.id]);
              });
              break;
            case "bluetooth":
              await controller.run("Share Bluetooth", async () => {
                await audio.stop(true);
                return controller.shareBluetooth(args.ids);
              });
              break;
            case "prepare":
              if (controller.busy)
                throw new Error("Wait for the room change to finish.");
              localMute = !!args.localMute;
              const prepared = audio.prepare(args.ids, args.format);
              controller.diagnostics.write("capture-options", {
                localMute,
                format: args.format,
                network: controller.network,
              });
              captureUntil = Date.now() + 30000;
              return prepared;
            case "captureReport":
              if (audio.session && args.id !== audio.session.id)
                return { ignored: true };
              {
                const message = String(args.message || "").slice(0, 500);
                controller.diagnostics.write("windows-capture", { message });
                if (args.failed) {
                  audio.lastError = message;
                  controller.log(message, "error");
                }
              }
              return { ok: true };
            case "stream":
              return await controller.run("Start desktop audio", () =>
                audio.play(args.id),
              );
            case "stop":
              captureUntil = 0;
              return await controller.run("Stop desktop audio", () =>
                audio.stop(true),
              );
            case "network":
              await controller.run("Change network", () =>
                controller.changeInterface(args.address),
              );
              break;
            case "addAddress":
              await controller.run("Find speaker", () =>
                controller.addAddress(args.address),
              );
              break;
            case "firewall":
              await controller.run(
                "Allow home speaker connections",
                async () => {
                  await allowHomeNetwork({
                    script: app.isPackaged
                      ? path.join(
                          process.resourcesPath,
                          "allow-home-network.ps1",
                        )
                      : path.join(
                          directory,
                          "platform",
                          "allow-home-network.ps1",
                        ),
                    executable: process.execPath,
                    network: controller.network,
                  });
                  await controller.closeSubscriptions();
                  void controller.subscribeAll();
                },
              );
              break;
            case "export": {
              const result = await dialog.showSaveDialog(window, {
                title: "Save connection report",
                defaultPath: "Housecast-diagnostics.json",
                filters: [{ name: "JSON report", extensions: ["json"] }],
              });
              if (!result.canceled) {
                const state = controller.snapshot();
                delete state.audio.id;
                await fs.writeFile(
                  result.filePath,
                  JSON.stringify(
                    {
                      appVersion: app.getVersion(),
                      createdAt: new Date().toISOString(),
                      history: await controller.diagnostics.read(),
                      ...state,
                    },
                    null,
                    2,
                  ),
                );
                return { saved: true };
              }
              return { saved: false };
            }
            default:
              throw new Error("Unknown application command.");
          }
          return controller.snapshot();
        } catch (error) {
          return { error: error.message };
        }
      });
      ipcMain.on("housecast:audio", (event, id, buffer, level) => {
        if (
          event.sender === window.webContents &&
          event.senderFrame?.url === rendererUrl
        )
          audio.push(id, buffer, level);
      });
      window.webContents.on("render-process-gone", () => {
        void audio.stop(true).catch((e) => controller.log(e.message, "error"));
      });
      window.once("ready-to-show", () => window.show());
      // Connect saved rooms while the window loads so the first view can already
      // contain live speaker state instead of waiting for renderer startup.
      controller
        .start()
        .catch((error) =>
          controller.log(`Connection: ${error.message}`, "error"),
        );
      app.on("before-quit", (event) => {
        if (quitting) return;
        event.preventDefault();
        quitting = true;
        void (async () => {
          try {
            await audio.stop(true);
            await controller.close();
          } catch {
          } finally {
            app.quit();
          }
        })();
      });
      app.on("window-all-closed", () => app.quit());
      await window.loadURL(rendererUrl);
    })
    .catch((error) => {
      dialog.showErrorBox(`${APP_NAME} could not start`, error.message);
      app.exit(1);
    });
}
