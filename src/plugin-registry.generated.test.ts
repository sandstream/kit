/**
 * The registry must describe plugins that exist, with the versions they were published at.
 *
 * The hand-written table this replaces was not merely stale, it was fabricated — measured against
 * npm and GitHub:
 *
 *   - `package: "@kit/plugins/stripe"` — no such package; the real one is
 *     `sandstream-kit-plugin-stripe`, so the printed install command could not work;
 *   - `version: "1.0.0"` — the published packages are 0.1.0 / 0.2.0;
 *   - `repository: "https://github.com/sandstream/kit-stripe"` — HTTP 404;
 *   - `rating: 4.8` and `downloads: 1250` — no source anywhere, printed as `★★★★◆ 4.8`;
 *   - `updated: new Date().toISOString()` — evaluated at import, so it always claimed to be current;
 *   - five entries for eleven shipped plugins, so `kit plugin search cloudflare` answered "No
 *     plugins found" about a package that is on npm.
 *
 * These tests are the reason it cannot happen again: the registry is generated, the generation is
 * byte-idempotent, and every entry is checked against the package it names.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { DEFAULT_REGISTRY, searchPlugins } from "./plugins.js";
import { OFFICIAL_PLUGINS } from "./plugin-registry.generated.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function shippedPluginDirs(): string[] {
  return readdirSync(join(REPO_ROOT, "packages"))
    .filter((d) => d.startsWith("kit-plugin-"))
    .sort();
}

describe("the plugin registry", () => {
  it("lists every plugin package that ships", () => {
    const listed = new Set(OFFICIAL_PLUGINS.map((p) => p.name));
    const missing = shippedPluginDirs()
      .map((d) => d.replace(/^kit-plugin-/, ""))
      .filter((id) => !listed.has(id));
    assert.deepEqual(
      missing,
      [],
      `shipped but undiscoverable — \`kit plugin search\` cannot find these: ${missing.join(", ")}`,
    );
  });

  it("names the package each plugin is actually published as, at its real version", () => {
    for (const plugin of OFFICIAL_PLUGINS) {
      const manifest = JSON.parse(
        readFileSync(
          join(REPO_ROOT, "packages", `kit-plugin-${plugin.name}`, "package.json"),
          "utf-8",
        ),
      ) as { name: string; version: string };
      assert.equal(plugin.package, manifest.name, `${plugin.name}: package name`);
      assert.equal(plugin.version, manifest.version, `${plugin.name}: version`);
      assert.equal(
        plugin.install,
        `npm install ${manifest.name}`,
        `${plugin.name}: the printed install command must be runnable`,
      );
    }
  });

  it("claims no rating, download count or publish date — kit has no source for any of them", () => {
    for (const plugin of OFFICIAL_PLUGINS) {
      assert.equal(plugin.rating, undefined, `${plugin.name}: a rating with no source is invented`);
      assert.equal(plugin.downloads, undefined, `${plugin.name}: same for downloads`);
      assert.equal(plugin.published, undefined, `${plugin.name}: same for the publish date`);
    }
    // And the registry itself must not claim freshness it cannot know.
    assert.equal(DEFAULT_REGISTRY.updated, undefined);
  });

  it("points every repository link at one real repository", () => {
    const root = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf-8")) as {
      repository?: string | { url?: string };
    };
    const expected = (
      typeof root.repository === "string" ? root.repository : (root.repository?.url ?? "")
    )
      .replace(/^git\+/, "")
      .replace(/\.git$/, "");
    for (const plugin of OFFICIAL_PLUGINS) {
      assert.equal(plugin.repository, expected || "https://github.com/sandstream/kit", plugin.name);
    }
  });

  it("is findable by the name a person would type", () => {
    for (const id of ["cloudflare", "stripe", "wiz"]) {
      const hits = searchPlugins(id);
      assert.ok(hits.length > 0, `\`kit plugin search ${id}\` must find the shipped plugin`);
    }
  });

  it("is byte-identical to what the generator emits", async () => {
    const mod = (await import(
      pathToFileURL(join(REPO_ROOT, "scripts", "gen-plugin-registry.mjs")).href
    )) as { render: () => string };
    const generated = mod.render();
    const committed = readFileSync(join(REPO_ROOT, "src", "plugin-registry.generated.ts"), "utf-8");
    if (generated !== committed) {
      const g = generated.split("\n");
      const c = committed.split("\n");
      const i = g.findIndex((line, idx) => line !== c[idx]);
      assert.fail(
        `line ${i + 1} differs — run \`node scripts/gen-plugin-registry.mjs\`\n` +
          `  generated: ${JSON.stringify(g[i])}\n  committed: ${JSON.stringify(c[i])}`,
      );
    }
  });
});
