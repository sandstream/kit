import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { rmSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  getMcpToken,
  setMcpToken,
  clearMcpToken,
  statusForMcp,
  statusAll,
  resolveMcpToken,
  storeStaticToken,
} from "./mcp-orchestrator.js";
import type { McpServerConfig } from "./config.js";

const TOKEN_FILE = join(homedir(), ".kit", "mcp-tokens.json");

async function reset() {
  if (existsSync(TOKEN_FILE)) rmSync(TOKEN_FILE);
}

describe("mcp-orchestrator token store", () => {
  afterEach(async () => {
    await reset();
  });

  it("getMcpToken returns null when nothing stored", async () => {
    await reset();
    assert.equal(await getMcpToken("sentry"), null);
  });

  it("setMcpToken + getMcpToken roundtrip", async () => {
    await reset();
    await setMcpToken("sentry", { accessToken: "abc", scopes: ["org:read"] });
    const t = await getMcpToken("sentry");
    assert.equal(t?.accessToken, "abc");
    assert.deepEqual(t?.scopes, ["org:read"]);
  });

  it("clearMcpToken removes the named entry only", async () => {
    await reset();
    await setMcpToken("sentry", { accessToken: "a" });
    await setMcpToken("stripe", { accessToken: "b" });
    await clearMcpToken("sentry");
    assert.equal(await getMcpToken("sentry"), null);
    assert.ok((await getMcpToken("stripe"))?.accessToken === "b");
  });

  it("token file is chmod 0o600", async () => {
    await reset();
    await setMcpToken("test", { accessToken: "x" });
    const { statSync } = await import("node:fs");
    const mode = statSync(TOKEN_FILE).mode & 0o777;
    assert.equal(mode, 0o600);
  });
});

describe("statusForMcp", () => {
  afterEach(async () => {
    await reset();
  });

  it("unconfigured when not declared", async () => {
    const s = await statusForMcp("sentry", null);
    assert.equal(s.status, "unconfigured");
  });

  it("missing when declared but no token", async () => {
    await reset();
    const s = await statusForMcp("sentry", { scopes: ["org:read"] });
    assert.equal(s.status, "missing");
  });

  it("ok when token covers declared scopes", async () => {
    await reset();
    await setMcpToken("sentry", { accessToken: "x", scopes: ["org:read"] });
    const s = await statusForMcp("sentry", { scopes: ["org:read"] });
    assert.equal(s.status, "ok");
  });

  it("scope-mismatch when token misses a declared scope", async () => {
    await reset();
    await setMcpToken("sentry", { accessToken: "x", scopes: ["org:read"] });
    const s = await statusForMcp("sentry", {
      scopes: ["org:read", "project:write"],
    });
    assert.equal(s.status, "scope-mismatch");
    assert.match(s.detail!, /project:write/);
  });

  it("expired when expiresAt is past", async () => {
    await reset();
    await setMcpToken("sentry", {
      accessToken: "x",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    const s = await statusForMcp("sentry", { scopes: [] });
    assert.equal(s.status, "expired");
  });
});

describe("statusAll", () => {
  it("returns [] when no config", async () => {
    const entries = await statusAll(undefined);
    assert.deepEqual(entries, []);
  });

  it("iterates declared MCPs", async () => {
    await reset();
    const config: Record<string, McpServerConfig> = {
      sentry: { scopes: ["org:read"] },
      stripe: { scopes: ["webhooks:write"] },
    };
    const entries = await statusAll(config);
    assert.equal(entries.length, 2);
    const names = entries.map((e) => e.name).sort();
    assert.deepEqual(names, ["sentry", "stripe"]);
  });
});

describe("resolveMcpToken", () => {
  afterEach(async () => {
    await reset();
  });

  it("throws when missing", async () => {
    await reset();
    await assert.rejects(() => resolveMcpToken("sentry"), /No MCP token/);
  });

  it("throws when expired", async () => {
    await reset();
    await setMcpToken("sentry", {
      accessToken: "x",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    await assert.rejects(() => resolveMcpToken("sentry"), /expired/);
  });

  it("returns the bearer when valid", async () => {
    await reset();
    await setMcpToken("sentry", { accessToken: "abc" });
    assert.equal(await resolveMcpToken("sentry"), "abc");
  });
});

describe("storeStaticToken", () => {
  afterEach(async () => {
    await reset();
  });

  it("ttlSeconds sets expiresAt in the future", async () => {
    await reset();
    await storeStaticToken("sentry", "x", { ttlSeconds: 60 });
    const t = await getMcpToken("sentry");
    assert.ok(t?.expiresAt);
    const exp = Date.parse(t!.expiresAt!);
    assert.ok(exp > Date.now() && exp <= Date.now() + 60_000 + 1000);
  });

  it("without ttlSeconds writes no expiresAt", async () => {
    await reset();
    await storeStaticToken("sentry", "x");
    const t = await getMcpToken("sentry");
    assert.equal(t?.expiresAt, undefined);
  });
});

describe("file-format sanity", () => {
  afterEach(async () => {
    await reset();
  });

  it("stored file is valid JSON", async () => {
    await reset();
    await setMcpToken("sentry", { accessToken: "x" });
    const text = readFileSync(TOKEN_FILE, "utf-8");
    const parsed = JSON.parse(text);
    assert.equal(parsed.sentry.accessToken, "x");
  });
});
