import fs from "node:fs/promises";
import path from "node:path";
import { extractFile } from "@electron/asar";
const archive = path.resolve("release/win-unpacked/resources/app.asar");
let checked = 0;
async function walk(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(file);
    else {
      const actual = extractFile(archive, file);
      if (!actual.equals(await fs.readFile(file)))
        throw new Error("Packaged source differs: " + file);
      checked++;
    }
  }
}
await walk("app");
const source = JSON.parse(await fs.readFile("package.json", "utf8"));
const packaged = JSON.parse(extractFile(archive, "package.json"));
if (source.version !== packaged.version)
  throw new Error("Package version mismatch");
console.log(
  JSON.stringify({ version: packaged.version, verifiedFiles: checked }),
);
