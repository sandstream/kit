import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { warnUnknownConfigKeys } from "./config-unknown-keys.js";

const SECTIONS = new Set(["tools", "browser"]);

describe("warnUnknownConfigKeys", () => {
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
