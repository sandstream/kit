import { describe, it, afterEach, before, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync, existsSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
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

/**
 * The token store, redirected into a temp dir for the whole file.
 *
 * This used to be `join(homedir(), ".kit", "mcp-tokens.json")` — the developer's REAL token store —
 * and `reset()` below deletes it. So `npm test` destroyed whatever MCP tokens the machine had, on
 * every run, silently. The path could not be redirected because `mcp-orchestrator.ts` bound it to
 * `homedir()` in a module-level const; it now resolves per call and honours KIT_MCP_TOKENS_DIR,
 * which is what makes this containment possible.
 */
let TOKEN_DIR: string;
let TOKEN_FILE: string;
const prevTokenDir = process.env.KIT_MCP_TOKENS_DIR;

before(() => {
  TOKEN_DIR = mkdtempSync(join(tmpdir(), "kit-mcp-tokens-"));
  TOKEN_FILE = join(TOKEN_DIR, "mcp-tokens.json");
  process.env.KIT_MCP_TOKENS_DIR = TOKEN_DIR;
});

after(() => {
  if (prevTokenDir === undefined) delete process.env.KIT_MCP_TOKENS_DIR;
  else process.env.KIT_MCP_TOKENS_DIR = prevTokenDir;
  rmSync(TOKEN_DIR, { recursive: true, force: true });
});

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

  it("token file is restricted to the owner", async () => {
    await reset();
    await setMcpToken("test", { accessToken: "x" });
    if (process.platform === "win32") {
      // NTFS ignores POSIX mode bits — secure-perms restricts the file via
      // `icacls` instead, whose ACL we can't read back portably here. Assert the
      // file was written (the icacls best-effort hardening ran after). #43.
      assert.ok(existsSync(TOKEN_FILE));
    } else {
      const { statSync } = await import("node:fs");
      const mode = statSync(TOKEN_FILE).mode & 0o777;
      assert.equal(mode, 0o600);
    }
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

describe("resolveMcpToken — error contract and expiry edges", () => {
  afterEach(async () => {
    await reset();
  });

  it("names the MCP and the exact remediation command when no token is stored", async () => {
    await reset();
    // The whole point of throwing here (rather than returning a bad bearer) is a
    // clear operator message. Pin BOTH halves: the server name must be
    // interpolated — not a hardcoded example — and the copy-pasteable command
    // must name the same server, or the error stops being actionable.
    await assert.rejects(() => resolveMcpToken("acme-internal"), {
      message: /No MCP token for "acme-internal"/,
    });
    await assert.rejects(() => resolveMcpToken("acme-internal"), {
      message: /kit mcp auth acme-internal/,
    });
  });

  it("puts the expiry timestamp in the expired error", async () => {
    await reset();
    const expiresAt = new Date(Date.now() - 60_000).toISOString();
    await setMcpToken("sentry", { accessToken: "x", expiresAt });
    // Without the timestamp an operator cannot tell a just-lapsed token from one
    // that died months ago, which changes what they should do about it.
    await assert.rejects(() => resolveMcpToken("sentry"), {
      message: new RegExp(expiresAt.replace(/[.+]/g, "\\$&")),
    });
  });

  it("resolves a token whose expiresAt is still in the future", async () => {
    await reset();
    await setMcpToken("sentry", {
      accessToken: "live",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    assert.equal(await resolveMcpToken("sentry"), "live");
  });

  it("treats an unparseable expiresAt as no expiry and returns the token", async () => {
    await reset();
    await setMcpToken("sentry", { accessToken: "abc", expiresAt: "not-a-date" });
    // Date.parse gives NaN, the Number.isFinite guard is false, so the expiry
    // check is skipped entirely. This is a FAIL-OPEN branch: a corrupt or
    // truncated expiresAt makes the token look eternally valid rather than
    // suspect. Asserted as-is so a deliberate change to fail-closed shows up
    // here as a failing test instead of passing silently.
    assert.equal(await resolveMcpToken("sentry"), "abc");
  });

  it("ignores an empty-string expiresAt (falsy) rather than rejecting it", async () => {
    await reset();
    await setMcpToken("sentry", { accessToken: "abc", expiresAt: "" });
    assert.equal(await resolveMcpToken("sentry"), "abc");
  });

  it("does not enforce declared scopes — a scope-mismatched token still resolves", async () => {
    await reset();
    await setMcpToken("sentry", { accessToken: "narrow", scopes: ["org:read"] });
    const declared: McpServerConfig = { scopes: ["org:read", "project:write"] };
    // statusForMcp calls this exact state a problem...
    assert.equal((await statusForMcp("sentry", declared)).status, "scope-mismatch");
    // ...but resolveMcpToken hands the bearer over anyway: it never sees the
    // declared config. Documented, not wished away — callers that need scope
    // enforcement must consult statusForMcp themselves, and anyone tempted to
    // rely on resolve* for authorization should see this test first.
    assert.equal(await resolveMcpToken("sentry"), "narrow");
  });

  it("matches the server name exactly — a token for another MCP does not satisfy it", async () => {
    await reset();
    await setMcpToken("stripe", { accessToken: "stripe-token" });
    // No prefix/fuzzy fallback: leaking one vendor's bearer into another
    // vendor's API call would be the worst possible convenience.
    await assert.rejects(() => resolveMcpToken("sentry"), /No MCP token for "sentry"/);
    await assert.rejects(() => resolveMcpToken("strip"), /No MCP token for "strip"/);
    await assert.rejects(() => resolveMcpToken("stripe-eu"), /No MCP token for "stripe-eu"/);
  });

  it("returns an empty accessToken as-is instead of treating it as missing", async () => {
    await reset();
    await setMcpToken("sentry", { accessToken: "" });
    // An entry exists, so the missing-token guard does not fire and the empty
    // string is returned — a caller would send `Authorization: Bearer `.
    // Current behaviour; see notes.
    assert.equal(await resolveMcpToken("sentry"), "");
  });

  it("does not throw for names inherited from Object.prototype (current behaviour)", async () => {
    await reset();
    // The store is a bare JSON.parse result, so `store[name]` finds inherited
    // members for these names: `store["__proto__"]` is Object.prototype and
    // `store["constructor"]` is Object — both truthy, so the `if (!token)`
    // fail-closed guard is bypassed and `.accessToken` is undefined. The
    // function's contract says it throws when a token is missing; for these
    // names it resolves with undefined instead. Asserted as the behaviour that
    // exists today, and flagged as a real defect in notes.
    assert.equal(await resolveMcpToken("__proto__"), undefined);
    assert.equal(await resolveMcpToken("constructor"), undefined);
  });
});
