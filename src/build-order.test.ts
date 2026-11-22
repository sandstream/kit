/**
 * `scripts/build.mjs` compiles `adapter-sdk` and `kit-plugin-supabase` first, then the root and
 * every other package at the same time. That is only correct while nothing else is imported
 * across packages. This test fails when an import is added that the build order does not know.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = readFileSync(join(ROOT, "scripts", "build.mjs"), "utf-8");
const first = JSON.parse(script.match(/const FIRST = (\[[^\]]*\]);/)?.[1] ?? "[]") as string[];

/** `sandstream-kit-adapter-sdk` is `packages/adapter-sdk`; a plugin keeps its `kit-` prefix. */
const dirOf = (npmName: string) =>
  npmName === "sandstream-kit-adapter-sdk" ? "adapter-sdk" : npmName.replace(/^sandstream-/, "");

function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) sources(join(dir, e.name), out);
    else if (e.name.endsWith(".ts")) out.push(join(dir, e.name));
  }
  return out;
}

function importedPackages(dir: string): Set<string> {
  const found = new Set<string>();
  for (const file of sources(dir)) {
    const text = readFileSync(file, "utf-8");
    for (const m of text.matchAll(/(?:from\s+|import\()\s*["'](sandstream-kit-[a-z0-9-]+)/g)) {
      found.add(dirOf(m[1]));
    }
  }
  return found;
}

describe("build order", () => {
  it("names the packages it builds first", () => {
    assert.deepEqual(first, ["adapter-sdk", "kit-plugin-supabase"]);
  });

  it("the root imports only packages that are built before it", () => {
    const extra = [...importedPackages(join(ROOT, "src"))].filter((p) => !first.includes(p));
    assert.deepEqual(extra, [], "add these to FIRST in scripts/build.mjs, in dependency order");
  });

  it("a package imports only adapter-sdk, which is built first of all", () => {
    for (const name of readdirSync(join(ROOT, "packages"))) {
      if (name === "adapter-sdk") continue;
      const imported = [...importedPackages(join(ROOT, "packages", name, "src"))].filter(
        (p) => p !== name,
      );
      assert.deepEqual(
        imported.filter((p) => p !== "adapter-sdk"),
        [],
        `packages/${name} imports another package: scripts/build.mjs builds them at the same time`,
      );
    }
  });

  it("npm run build, build:prod and build:dev all go through the script", () => {
    const scripts = (
      JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8")) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    assert.equal(scripts.build, "node scripts/build.mjs");
    assert.equal(scripts["build:prod"], "node scripts/build.mjs --prod");
    assert.equal(scripts["build:dev"], "node scripts/build.mjs --incremental");
  });
});
