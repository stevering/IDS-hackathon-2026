// Post-version hook: propagate package.json versions into store manifests.
//
// Figma manifests do not carry a "version" field (Figma Community handles
// versioning on its dashboard), so only the Chrome extension manifest is
// synchronised here. Add new entries to SYNC_TARGETS if other artefacts gain
// a versioned manifest.

import { readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SYNC_TARGETS = [
  {
    pkg: "packages/chrome-extension/package.json",
    manifest: "packages/chrome-extension/manifest.json",
  },
];

let changed = 0;
for (const { pkg, manifest } of SYNC_TARGETS) {
  const pkgPath = resolve(root, pkg);
  const manifestPath = resolve(root, manifest);

  const pkgJson = JSON.parse(await readFile(pkgPath, "utf8"));
  const manifestJson = JSON.parse(await readFile(manifestPath, "utf8"));

  if (manifestJson.version === pkgJson.version) {
    console.log(`✓ ${manifest} already at ${pkgJson.version}`);
    continue;
  }

  const previous = manifestJson.version;
  manifestJson.version = pkgJson.version;
  await writeFile(manifestPath, JSON.stringify(manifestJson, null, 2) + "\n");
  console.log(`✓ ${manifest}: ${previous} → ${pkgJson.version}`);
  changed += 1;
}

if (changed === 0) {
  console.log("No manifest changes needed.");
}
