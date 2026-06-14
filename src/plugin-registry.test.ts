import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PluginRegistry,
  createRegistryFromSkillsLock,
  getValidWebSearchProviders,
  type PluginManifest,
} from "./plugin-registry.js";
import type { SkillsLockFile } from "./skills.js";

function manifest(name: string, capabilities: PluginManifest["capabilities"]): PluginManifest {
  return { name, version: "1.0.0", capabilities };
}

describe("PluginRegistry", () => {
  it("registerPlugin + getWebSearchProviders surfaces only matching type", () => {
    const r = new PluginRegistry();
    r.registerPlugin(
      manifest("searxng-plugin", [
        { name: "searxng", type: "web_search_provider", version: "1.0.0" },
        { name: "other", type: "tool", version: "1.0.0" },
      ]),
    );
    const providers = r.getWebSearchProviders();
    assert.equal(providers.size, 1);
    assert.ok(providers.has("searxng"));
  });

  it("getCapabilitiesByType filters across plugins", () => {
    const r = new PluginRegistry();
    r.registerPlugin(
      manifest("a", [{ name: "x", type: "secret_store", version: "1.0.0" }]),
    );
    r.registerPlugin(
      manifest("b", [{ name: "y", type: "secret_store", version: "1.0.0" }]),
    );
    r.registerPlugin(
      manifest("c", [{ name: "z", type: "tool", version: "1.0.0" }]),
    );
    const stores = r.getCapabilitiesByType("secret_store");
    assert.equal(stores.size, 2);
    assert.ok(stores.has("x"));
    assert.ok(stores.has("y"));
    assert.ok(!stores.has("z"));
  });

  it("hasProvider + getProvider return correct values", () => {
    const r = new PluginRegistry();
    r.registerPlugin(
      manifest("p", [
        { name: "searxng", type: "web_search_provider", version: "1.0.0" },
      ]),
    );
    assert.equal(r.hasProvider("searxng"), true);
    assert.equal(r.hasProvider("brave"), false);
    const cap = r.getProvider("searxng");
    assert.equal(cap?.type, "web_search_provider");
    assert.equal(r.getProvider("missing"), undefined);
  });

  it("re-registering same plugin@version replaces capabilities", () => {
    const r = new PluginRegistry();
    r.registerPlugin(manifest("p", [{ name: "old", type: "tool", version: "1.0.0" }]));
    r.registerPlugin(manifest("p", [{ name: "new", type: "tool", version: "1.0.0" }]));
    const tools = r.getCapabilitiesByType("tool");
    assert.equal(tools.size, 1);
    assert.ok(tools.has("new"));
    assert.ok(!tools.has("old"));
  });

  it("clear() empties the registry", () => {
    const r = new PluginRegistry();
    r.registerPlugin(manifest("p", [{ name: "x", type: "tool", version: "1.0.0" }]));
    r.clear();
    assert.equal(r.getCapabilitiesByType("tool").size, 0);
  });
});

describe("createRegistryFromSkillsLock", () => {
  it("registers searxng as a web_search_provider", () => {
    const lock: SkillsLockFile = {
      version: 1,
      generated: "2026-01-01T00:00:00Z",
      skills: {
        searxng: { version: "1.0.0", source: "claude-skills" } as never,
      },
    } as unknown as SkillsLockFile;
    const r = createRegistryFromSkillsLock(lock);
    assert.equal(r.hasProvider("searxng"), true);
    const cap = r.getProvider("searxng");
    assert.equal(cap?.type, "web_search_provider");
    assert.equal((cap?.config as { url: string }).url, "http://localhost:8080");
  });

  it("ignores skills that aren't searxng", () => {
    const lock: SkillsLockFile = {
      version: 1,
      generated: "2026-01-01T00:00:00Z",
      skills: {
        "some-other-skill": { version: "1.0.0", source: "claude-skills" } as never,
      },
    } as unknown as SkillsLockFile;
    const r = createRegistryFromSkillsLock(lock);
    assert.equal(r.getWebSearchProviders().size, 0);
  });

  it("matches skill names that contain 'searxng' (path-prefixed)", () => {
    const lock: SkillsLockFile = {
      version: 1,
      generated: "2026-01-01T00:00:00Z",
      skills: {
        "anthropics/searxng-skill": { version: "2.0.0", source: "claude-skills" } as never,
      },
    } as unknown as SkillsLockFile;
    const r = createRegistryFromSkillsLock(lock);
    assert.equal(r.hasProvider("searxng"), true);
  });
});

describe("getValidWebSearchProviders", () => {
  it("returns the built-in set when no registry passed", () => {
    const providers = getValidWebSearchProviders();
    assert.deepEqual(providers.sort(), ["brave", "custom", "google", "searxng"]);
  });

  it("merges built-ins with plugin-registered providers (deduped)", () => {
    const r = new PluginRegistry();
    r.registerPlugin(
      manifest("p", [
        // Already in built-ins — should not duplicate.
        { name: "searxng", type: "web_search_provider", version: "1.0.0" },
        // Net-new from plugin.
        { name: "kagi", type: "web_search_provider", version: "1.0.0" },
      ]),
    );
    const providers = getValidWebSearchProviders(r);
    assert.deepEqual(providers.sort(), ["brave", "custom", "google", "kagi", "searxng"]);
  });
});
