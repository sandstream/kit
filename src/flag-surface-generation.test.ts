import { it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Equal flag sets are insufficient: regeneration must also preserve the file format.
it("flag regeneration emits exactly the committed file", async () => {
  const mod = (await import(
    pathToFileURL(join(REPO_ROOT, "scripts", "derive-command-flags.mjs")).href
  )) as {
    deriveFlagSurface: (depth?: number) => {
      surface: Record<string, string[]>;
      bareFlags: Record<string, string[]>;
    };
    emit: (surface: Record<string, string[]>, bareFlags: Record<string, string[]>) => string;
  };
  const { surface, bareFlags } = mod.deriveFlagSurface();
  const generated = mod.emit(surface, bareFlags);
  const committed = readFileSync(join(REPO_ROOT, "src", "flag-surface.ts"), "utf-8");

  if (generated !== committed) {
    const g = generated.split("\n");
    const c = committed.split("\n");
    const firstDifference = g.findIndex((line, idx) => line !== c[idx]);
    const i = firstDifference < 0 ? g.length : firstDifference;
    assert.fail(
      `line ${i + 1} differs. Run \`node scripts/derive-command-flags.mjs --emit\`.\n` +
        `  generated: ${JSON.stringify(g[i])}\n  committed: ${JSON.stringify(c[i])}`,
    );
  }
});
