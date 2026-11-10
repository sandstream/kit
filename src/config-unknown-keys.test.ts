import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createCliContractFixture } from "./cli-contract.test-support.js";
import { loadConfig } from "./config.js";
import { warnUnknownConfigKeys } from "./config-unknown-keys.js";

const SECTIONS = new Set(["tools", "browser"]);

const warnings: string[] = [];
const realWarn = console.warn;
beforeEach(() => {
  warnings.length = 0;
  console.warn = (msg?: unknown) => {
    warnings.push(String(msg));
  };
});
afterEach(() => {
  console.warn = realWarn;
});

describe("warnUnknownConfigKeys", () => {
  it("warns about an unknown top-level section and names the known ones", () => {
    warnUnknownConfigKeys("a/.kit.toml", { tolls: {}, tools: {} }, SECTIONS, undefined);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /unknown section \[tolls\]/);
    assert.match(warnings[0], /known: tools, browser/);
  });

  it("warns about an unknown [browser] key and keeps the known ones silent", () => {
    warnUnknownConfigKeys("b/.kit.toml", {}, SECTIONS, { port: 3000, strategy: "x" });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /unknown key \[browser\]\.strategy/);
  });

  it("warns once per file and key across repeated loads", () => {
    for (let i = 0; i < 3; i++) {
      warnUnknownConfigKeys("c/.kit.toml", {}, SECTIONS, { typo: 1 });
    }
    assert.equal(warnings.length, 1);
    warnUnknownConfigKeys("d/.kit.toml", {}, SECTIONS, { typo: 1 });
    assert.equal(warnings.length, 2);
  });

  it("is silent for a clean config", () => {
    warnUnknownConfigKeys("e/.kit.toml", { tools: {} }, SECTIONS, { app: "x", cdp_url: "y" });
    assert.deepEqual(warnings, []);
  });
});

describe("unknown configuration fields retain their identity", () => {
  it("retains raw key identity when different browser keys have the same safe display", () => {
    const browser = { "typo\x1b[31m": "first", "typo\x1b[32m": "second" };
    const original = structuredClone(browser);
    for (let i = 0; i < 2; i++) {
      warnUnknownConfigKeys("collisions/.kit.toml", {}, SECTIONS, browser);
    }
    assert.equal(warnings.length, 2);
    assert.equal(warnings[0], warnings[1]);
    assert.match(warnings[0], /unknown key \[browser\]\.typo in/);
    assert.doesNotMatch(warnings.join(""), /\x1b/);
    warnUnknownConfigKeys("another-file/.kit.toml", {}, SECTIONS, browser);
    assert.equal(warnings.length, 4);
    assert.deepEqual(browser, original);
  });

  it("preserves unknown fields through repeated public config loads", async (t) => {
    const rootKey = "future\x1b[2J\nsection";
    const browserKey = `future\nkey ghp_${"c".repeat(36)}`;
    const fixture = createCliContractFixture(`version = 1
${JSON.stringify(rootKey)} = { retained = true }
[browser]
port = 3107
${JSON.stringify(browserKey)} = "retained-browser-value"
`);
    t.after(() => fixture.cleanup());
    const before = fixture.snapshot();
    for (let i = 0; i < 2; i++) {
      const config = await loadConfig(join(fixture.cwd, ".kit.toml"), "dev");
      assert.deepEqual(Object.entries(Object.getOwnPropertyDescriptor(config, rootKey)?.value), [
        ["retained", true],
      ]);
      assert.ok(config.browser);
      assert.equal(
        Object.getOwnPropertyDescriptor(config.browser, browserKey)?.value,
        "retained-browser-value",
      );
      assert.equal(config.browser.port, 3107);
    }
    assert.equal(warnings.filter((line) => line.startsWith("Warning: unknown section")).length, 2);
    assert.equal(warnings.filter((line) => line.startsWith("Warning: unknown key")).length, 1);
    assert.doesNotMatch(warnings.join(""), /\x1b|\n|ghp_/);
    assert.deepEqual(fixture.snapshot(), before);
  });
});
