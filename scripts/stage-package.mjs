import fs from "node:fs/promises";
import path from "node:path";
const root = process.cwd(),
  pkg = JSON.parse(await fs.readFile("package.json", "utf8"));
const stage = path.join(root, `release/package-stage-${pkg.version}`);
await fs.mkdir(stage, { recursive: true });
await fs.cp(path.join(root, "app"), path.join(stage, "app"), {
  recursive: true,
});
await fs.copyFile(
  path.join(root, "THIRD-PARTY-NOTICES.md"),
  path.join(stage, "THIRD-PARTY-NOTICES.md"),
);
const seen = new Set();
async function add(name, from) {
  let dir = from,
    source;
  while (true) {
    const candidate = path.join(dir, "node_modules", name);
    if (await fs.stat(path.join(candidate, "package.json")).catch(() => null)) {
      source = candidate;
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("Missing dependency " + name);
    dir = parent;
  }
  if (seen.has(source)) return;
  seen.add(source);
  const relative = path.relative(path.join(root, "node_modules"), source);
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("Dependency outside project: " + source);
  await fs.cp(source, path.join(stage, "node_modules", relative), {
    recursive: true,
    filter: (file) =>
      file === source ||
      !path.relative(source, file).split(path.sep).includes("node_modules"),
  });
  const dependency = JSON.parse(
    await fs.readFile(path.join(source, "package.json"), "utf8"),
  );
  for (const child of Object.keys(dependency.dependencies || {}))
    await add(child, source);
}
for (const name of Object.keys(pkg.dependencies)) await add(name, root);
delete pkg.devDependencies;
delete pkg.scripts;
pkg.build = {
  ...pkg.build,
  npmRebuild: false,
  electronVersion: "44.4.5",
  electronDist: path.join(root, "node_modules/electron/dist"),
  directories: { output: path.join(root, "release") },
};
pkg.build.extraResources = pkg.build.extraResources?.map((r) => ({
  ...r,
  from: path.resolve(root, r.from),
}));
await fs.writeFile(
  path.join(stage, "package.json"),
  JSON.stringify(pkg, null, 2),
);
console.log(JSON.stringify({ stage, productionPackages: seen.size }));
