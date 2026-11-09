// Read-only UI smoke test. Launches the app, waits for the interface and for
// speaker discovery, and checks that no renderer errors occurred. It never
// changes playback, volume, grouping or sources.
//
// Usage:
//   node scripts/ui-smoke.mjs                 # development build
//   node scripts/ui-smoke.mjs --packaged      # release/win-unpacked/Housecast.exe
//   node scripts/ui-smoke.mjs --rooms=2       # also require 2 online rooms
import { _electron as electron } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";

const option = (name, fallback) =>
  process.argv.find((v) => v.startsWith(`--${name}=`))?.split("=")[1] ??
  fallback;
const packaged = process.argv.includes("--packaged");
const expectedRooms = Number(option("rooms", "0"));

await fs.mkdir("test-output", { recursive: true });
const launchedAt = performance.now();
const application = await electron.launch({
  ...(packaged
    ? { executablePath: path.resolve("release/win-unpacked/Housecast.exe") }
    : { args: ["."] }),
  env: {
    ...process.env,
    HOUSECAST_TEST_DATA: path.resolve(".app-test-data"),
  },
  timeout: 30000,
});
const errors = [];
let page;
try {
  page = await application.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForSelector("#stream", { timeout: 15000 });
  const title = await page.title();
  if (title !== "Housecast") throw new Error(`Unexpected title: ${title}`);

  if (expectedRooms > 0)
    await page.waitForFunction(
      (n) => document.querySelectorAll(".room-card:not(.offline)").length >= n,
      expectedRooms,
      { timeout: 30000 },
    );

  // Settings view must render the inventory without errors.
  await page.getByRole("button", { name: "Settings" }).click();
  await page.waitForSelector("#connection-view:not([hidden])");
  await page.getByRole("button", { name: "Playback" }).click();

  const state = await page.evaluate(() => window.housecast.command("state"));
  const summary = {
    launchMs: Math.round(performance.now() - launchedAt),
    appVersion: state.appVersion,
    network: state.network?.name || null,
    rooms: state.rooms.map(({ name, model, online }) => ({
      name,
      model,
      online,
    })),
    devices: state.devices.length,
  };
  console.log(JSON.stringify(summary, null, 2));
  await page.screenshot({ path: "test-output/ui-smoke.png", fullPage: true });
  if (errors.length) throw new Error(errors.join("\n"));
  console.log("UI smoke passed.");
} catch (error) {
  await page
    ?.screenshot({ path: "test-output/failure.png", fullPage: true })
    .catch(() => {});
  throw error;
} finally {
  await application.close();
}
