#!/usr/bin/env node
// Regenerate contracts/kit.opencli.json from the live command surface.
//
// Run after an intentional surface change:
//   npm run build && node scripts/gen-opencli.mjs
//
// opencli.test.ts diffs a fresh build against the committed snapshot and fails on
// drift, so this script is how an author acknowledges a command-surface change:
// review the diff, regenerate, commit. Sibling of scripts/gen-public-surface.mjs.
import { writeFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

const distEntry = join(repoRoot, "dist", "opencli.js");
if (!existsSync(distEntry)) {
  console.error("dist/opencli.js not found. Run `npm run build` first.");
  process.exit(1);
}

const { buildOpenCliDoc, serializeOpenCli } = await import(pathToFileURL(distEntry).href);

const out = join(repoRoot, "contracts", "kit.opencli.json");
writeFileSync(out, serializeOpenCli(buildOpenCliDoc()), "utf-8");
console.log(`wrote ${out}`);
