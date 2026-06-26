#!/usr/bin/env node
// Regenerate contracts/public-surface.json from the live, compiled public surface.
//
// Run after an intentional surface change:
//   npm run build && node scripts/gen-public-surface.mjs
//
// public-surface.test.ts diffs a fresh collection against the committed snapshot
// and fails on drift, so this script is how an author acknowledges a surface
// change: review the diff, regenerate, commit, and add a BREAKING note to the
// changelog/PR if the change removes or renames a stable contract.
import { writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

if (!existsSync(join(repoRoot, "dist", "public-surface.js"))) {
  console.error("dist/public-surface.js not found. Run `npm run build` first.");
  process.exit(1);
}

const { collectPublicSurface, serializePublicSurface } = await import(
  join(repoRoot, "dist", "public-surface.js")
);

const out = join(repoRoot, "contracts", "public-surface.json");
const json = serializePublicSurface(collectPublicSurface());
writeFileSync(out, json, "utf-8");
console.log(`wrote ${out}`);
