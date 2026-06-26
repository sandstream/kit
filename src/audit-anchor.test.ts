import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendAuditEventDirect } from "./audit.js";
import { randomBytes, createHash } from "node:crypto";
import {
  computeAnchorTip,
  anchorKeyFingerprint,
  lineHashes,
  anchorAuditLog,
  readAnchorRecord,
  verifyAgainstAnchor,
  decideAnchorVerdict,
  hasAnyAnchoredLogs,
  getAuditAnchorKey,
  tryReadAuditAnchorKey,
  tryAdvanceAnchorOnAppend,
  resolveExternalAnchor,
  type AnchorVerifyResult,
} from "./audit-anchor.js";

// Build a real hash-chained log without auto-anchoring (KIT_AUDIT_ANCHOR=0 is
// set by the test runner) so each test controls anchoring explicitly.
async function buildChain(cwd: string, n: number): Promise<string> {
  for (let i = 0; i < n; i++) {
    const ok = await appendAuditEventDirect(
      { operation: `op-${i}`, environment: "dev", success: true },
      { cwd },
    );
    assert.equal(ok, true);
  }
  return readFileSync(join(cwd, ".kit-audit.jsonl"), "utf-8");
}

describe("audit anchor - pure helpers", () => {
  it("computeAnchorTip is deterministic and key-dependent", () => {
    const k1 = Buffer.alloc(32, 1);
    const k2 = Buffer.alloc(32, 2);
    const hashes = ["aa", "bb", "cc"];
    assert.equal(computeAnchorTip(k1, hashes), computeAnchorTip(k1, hashes));
    assert.notEqual(computeAnchorTip(k1, hashes), computeAnchorTip(k2, hashes));
  });

  it("computeAnchorTip changes when any hash changes (order-sensitive)", () => {
    const k = Buffer.alloc(32, 7);
    assert.notEqual(computeAnchorTip(k, ["a", "b"]), computeAnchorTip(k, ["b", "a"]));
    assert.notEqual(computeAnchorTip(k, ["a", "b"]), computeAnchorTip(k, ["a", "b", "c"]));
  });

  it("lineHashes returns null for an unchained (legacy) line", () => {
    const legacy = JSON.stringify({ operation: "x", environment: "dev", success: true });
    assert.equal(lineHashes(legacy + "\n"), null);
  });
});

describe("audit anchor - key file", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kit-anchor-key-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("creates the key on first use (0600) and re-reads the same key", async () => {
    const k1 = await getAuditAnchorKey(dir);
    const k2 = await tryReadAuditAnchorKey(dir);
    assert.ok(k2);
    assert.ok(k1.equals(k2!));
  });

  it("tryReadAuditAnchorKey returns null when no key exists", async () => {
    const empty = mkdtempSync(join(tmpdir(), "kit-anchor-empty-"));
    try {
      assert.equal(await tryReadAuditAnchorKey(empty), null);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("audit anchor - sign + verify round-trip", () => {
  let cwd: string;
  let dir: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "kit-anchor-log-"));
    dir = mkdtempSync(join(tmpdir(), "kit-anchor-home-"));
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  it("anchors a chain and verifies it as anchored-ok", async () => {
    const content = await buildChain(cwd, 5);
    const logPath = join(cwd, ".kit-audit.jsonl");
    const rec = await anchorAuditLog(logPath, content, dir);
    assert.equal(rec.count, 5);

    const key = await tryReadAuditAnchorKey(dir);
    const stored = await readAnchorRecord(logPath, dir);
    const r = verifyAgainstAnchor(content, stored, key);
    assert.equal(r.status, "anchored-ok");
    assert.equal(r.newSinceAnchor, 0);
  });

  it("reports new unanchored entries appended after the seal (not a failure)", async () => {
    const content = await buildChain(cwd, 3);
    const logPath = join(cwd, ".kit-audit.jsonl");
    await anchorAuditLog(logPath, content, dir);
    const grown = await buildChain(cwd, 0); // re-read
    void grown;
    await appendAuditEventDirect(
      { operation: "later", environment: "dev", success: true },
      { cwd },
    );
    const after = readFileSync(logPath, "utf-8");

    const key = await tryReadAuditAnchorKey(dir);
    const stored = await readAnchorRecord(logPath, dir);
    const r = verifyAgainstAnchor(after, stored, key);
    assert.equal(r.status, "anchored-ok");
    assert.equal(r.newSinceAnchor, 1);
  });
});

describe("audit anchor - tamper detection", () => {
  let cwd: string;
  let dir: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "kit-anchor-t-"));
    dir = mkdtempSync(join(tmpdir(), "kit-anchor-th-"));
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  it("a chain recomputed WITHOUT the key fails on tip-mismatch", async () => {
    const content = await buildChain(cwd, 4);
    const logPath = join(cwd, ".kit-audit.jsonl");
    await anchorAuditLog(logPath, content, dir);
    const key = await tryReadAuditAnchorKey(dir);
    const stored = await readAnchorRecord(logPath, dir);

    // Tamperer rewrites entry 1 and re-chains the keyless hashes from genesis.
    // verifyAuditChain would PASS (no key), but the HMAC anchor catches it.
    const lines = content.trim().split("\n");
    const obj = JSON.parse(lines[1]);
    obj.operation = "tampered";
    // Recompute the keyless chain so the per-line chain stays internally valid.
    const { createHash } = await import("node:crypto");
    const GENESIS = "0".repeat(64);
    const rebuilt: string[] = [];
    let prev = GENESIS;
    const parsed = lines.map((l) => JSON.parse(l));
    parsed[1].operation = "tampered";
    for (const p of parsed) {
      const { hash: _h, prev: _p, ...rest } = p;
      void _h;
      void _p;
      const pre = JSON.stringify({ ...rest, prev });
      const hash = createHash("sha256").update(pre).digest("hex");
      rebuilt.push(JSON.stringify({ ...rest, prev, hash }));
      prev = hash;
    }
    const forged = rebuilt.join("\n") + "\n";

    // Sanity: the forged chain is internally consistent (keyless verify passes).
    const { verifyAuditChain } = await import("./audit.js");
    assert.equal(verifyAuditChain(forged).ok, true);

    // But the anchor catches it.
    const r = verifyAgainstAnchor(forged, stored, key);
    assert.equal(r.status, "tip-mismatch");
  });

  it("a truncated chain fails on the count check", async () => {
    const content = await buildChain(cwd, 6);
    const logPath = join(cwd, ".kit-audit.jsonl");
    await anchorAuditLog(logPath, content, dir);
    const key = await tryReadAuditAnchorKey(dir);
    const stored = await readAnchorRecord(logPath, dir);

    const lines = content.trim().split("\n").slice(0, 3); // drop the last 3
    const truncated = lines.join("\n") + "\n";
    const r = verifyAgainstAnchor(truncated, stored, key);
    assert.equal(r.status, "truncated");
    assert.equal(r.expected, 6);
    assert.equal(r.entries, 3);
  });

  it("legacy unanchored log verifies as no-anchor (warn, not error)", async () => {
    const content = await buildChain(cwd, 3);
    const key = await tryReadAuditAnchorKey(dir); // null - never created
    const r = verifyAgainstAnchor(content, null, key);
    assert.equal(r.status, "no-anchor");
  });

  it("anchor present but key unavailable downgrades to key-unavailable (warn)", async () => {
    const content = await buildChain(cwd, 2);
    const logPath = join(cwd, ".kit-audit.jsonl");
    const rec = await anchorAuditLog(logPath, content, dir);
    const r = verifyAgainstAnchor(content, rec, null);
    assert.equal(r.status, "key-unavailable");
    assert.equal(r.expected, 2);
  });
});

describe("audit anchor - append-path advance", () => {
  it("tryAdvanceAnchorOnAppend is a no-op when KIT_AUDIT_ANCHOR=0", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "kit-anchor-off-"));
    const dir = mkdtempSync(join(tmpdir(), "kit-anchor-offh-"));
    const prev = process.env.KIT_AUDIT_ANCHOR;
    process.env.KIT_AUDIT_ANCHOR = "0";
    try {
      await buildChain(cwd, 2);
      await tryAdvanceAnchorOnAppend(join(cwd, ".kit-audit.jsonl"), dir);
      assert.equal(await readAnchorRecord(join(cwd, ".kit-audit.jsonl"), dir), null);
    } finally {
      if (prev === undefined) delete process.env.KIT_AUDIT_ANCHOR;
      else process.env.KIT_AUDIT_ANCHOR = prev;
      rmSync(cwd, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("tryAdvanceAnchorOnAppend seals the log when enabled", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "kit-anchor-on-"));
    const dir = mkdtempSync(join(tmpdir(), "kit-anchor-onh-"));
    const prev = process.env.KIT_AUDIT_ANCHOR;
    const prevDir = process.env.KIT_AUDIT_ANCHOR_DIR;
    delete process.env.KIT_AUDIT_ANCHOR; // enabled by default
    // Redirect the DEFAULT anchor dir to temp so the append-path auto-anchor
    // inside buildChain cannot touch the real ~/.kit.
    process.env.KIT_AUDIT_ANCHOR_DIR = dir;
    try {
      await buildChain(cwd, 2);
      const logPath = join(cwd, ".kit-audit.jsonl");
      await tryAdvanceAnchorOnAppend(logPath, dir);
      const rec = await readAnchorRecord(logPath, dir);
      assert.ok(rec);
      assert.equal(rec!.count, 2);
    } finally {
      if (prev === undefined) delete process.env.KIT_AUDIT_ANCHOR;
      else process.env.KIT_AUDIT_ANCHOR = prev;
      if (prevDir === undefined) delete process.env.KIT_AUDIT_ANCHOR_DIR;
      else process.env.KIT_AUDIT_ANCHOR_DIR = prevDir;
      rmSync(cwd, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("audit anchor - key rotation (FIX 4)", () => {
  let cwd: string;
  let dir: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "kit-anchor-rot-"));
    dir = mkdtempSync(join(tmpdir(), "kit-anchor-roth-"));
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  it("anchorAuditLog records the key fingerprint (v2)", async () => {
    const content = await buildChain(cwd, 3);
    const logPath = join(cwd, ".kit-audit.jsonl");
    const rec = await anchorAuditLog(logPath, content, dir);
    const key = await tryReadAuditAnchorKey(dir);
    assert.equal(rec.keyFingerprint, anchorKeyFingerprint(key!));
    assert.equal(rec.version, 2);
  });

  it("a rotated key reports 'anchor-key-changed', NOT content tip-mismatch", async () => {
    const content = await buildChain(cwd, 3);
    const logPath = join(cwd, ".kit-audit.jsonl");
    const rec = await anchorAuditLog(logPath, content, dir);
    // Same (untampered) content, but verify under a DIFFERENT key = rotation.
    const rotatedKey = randomBytes(32);
    const r = verifyAgainstAnchor(content, rec, rotatedKey);
    assert.equal(r.status, "anchor-key-changed");
  });

  it("tryAdvanceAnchorOnAppend does NOT silently re-seal a non-verifying prefix", async () => {
    const content = await buildChain(cwd, 3);
    const logPath = join(cwd, ".kit-audit.jsonl");
    const rec = await anchorAuditLog(logPath, content, dir);
    const originalTip = rec.tip;
    const originalCount = rec.count;

    // Forge: rewrite entry 1 and re-chain the keyless hashes (verifyAuditChain
    // would pass, but the anchored prefix no longer matches under the key).
    const GENESIS = "0".repeat(64);
    const parsed = content
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    parsed[1].operation = "tampered";
    let prev = GENESIS;
    const rebuilt: string[] = [];
    for (const p of parsed) {
      const { hash: _h, prev: _p, ...rest } = p;
      void _h;
      void _p;
      const pre = JSON.stringify({ ...rest, prev });
      const hash = createHash("sha256").update(pre).digest("hex");
      rebuilt.push(JSON.stringify({ ...rest, prev, hash }));
      prev = hash;
    }
    const { writeFileSync } = await import("node:fs");
    writeFileSync(logPath, rebuilt.join("\n") + "\n", "utf-8");

    // Enable append-time anchoring for this call only.
    const prevEnv = process.env.KIT_AUDIT_ANCHOR;
    delete process.env.KIT_AUDIT_ANCHOR;
    try {
      await tryAdvanceAnchorOnAppend(logPath, dir);
    } finally {
      if (prevEnv === undefined) delete process.env.KIT_AUDIT_ANCHOR;
      else process.env.KIT_AUDIT_ANCHOR = prevEnv;
    }

    // The stored anchor MUST be unchanged: re-sealing would erase the alarm.
    const after = await readAnchorRecord(logPath, dir);
    assert.equal(after!.tip, originalTip);
    assert.equal(after!.count, originalCount);
  });
});

describe("audit anchor - verdict policy (FIX 2 + FIX 3)", () => {
  const mk = (over: Partial<AnchorVerifyResult>): AnchorVerifyResult => ({
    status: "anchored-ok",
    entries: 3,
    expected: 3,
    ...over,
  });

  it("ATTACK: no-anchor + machine has anchored logs => FAIL (path-repoint)", () => {
    const v = decideAnchorVerdict({
      result: mk({ status: "no-anchor" }),
      strict: false,
      machineHasAnchors: true,
    });
    assert.equal(v.ok, false);
    assert.equal(v.level, "error");
  });

  it("no-anchor + no strict + no anchored logs => warn (backward compat)", () => {
    const v = decideAnchorVerdict({
      result: mk({ status: "no-anchor" }),
      strict: false,
      machineHasAnchors: false,
    });
    assert.equal(v.ok, true);
    assert.equal(v.level, "warn");
  });

  it("ATTACK: forged unsealed tail => FAIL under strict", () => {
    const v = decideAnchorVerdict({
      result: mk({ status: "anchored-ok", entries: 5, expected: 3, newSinceAnchor: 2 }),
      strict: true,
      machineHasAnchors: true,
    });
    assert.equal(v.ok, false);
    assert.equal(v.level, "error");
    assert.match(v.message, /UNSEALED|UNAUTHENTICATED/);
  });

  it("unsealed tail without strict => surfaced loudly as warn (exit 0)", () => {
    const v = decideAnchorVerdict({
      result: mk({ status: "anchored-ok", entries: 5, expected: 3, newSinceAnchor: 2 }),
      strict: false,
      machineHasAnchors: false,
    });
    assert.equal(v.ok, true);
    assert.equal(v.level, "warn");
    assert.match(v.message, /UNSEALED|UNAUTHENTICATED/);
  });

  it("anchored-ok with no tail => ok", () => {
    const v = decideAnchorVerdict({
      result: mk({ newSinceAnchor: 0 }),
      strict: true,
      machineHasAnchors: true,
    });
    assert.equal(v.ok, true);
    assert.equal(v.level, "ok");
  });

  it("anchor-key-changed: warn by default, FAIL under strict (distinct from tamper)", () => {
    const warn = decideAnchorVerdict({
      result: mk({ status: "anchor-key-changed", reason: "rotated" }),
      strict: false,
      machineHasAnchors: true,
    });
    assert.equal(warn.ok, true);
    assert.equal(warn.level, "warn");
    const strict = decideAnchorVerdict({
      result: mk({ status: "anchor-key-changed", reason: "rotated" }),
      strict: true,
      machineHasAnchors: true,
    });
    assert.equal(strict.ok, false);
  });

  it("tip-mismatch / truncated / unparseable always FAIL", () => {
    for (const status of ["tip-mismatch", "truncated", "unparseable"] as const) {
      const v = decideAnchorVerdict({
        result: mk({ status, reason: status }),
        strict: false,
        machineHasAnchors: false,
      });
      assert.equal(v.ok, false, status);
      assert.equal(v.level, "error", status);
    }
  });
});

describe("audit anchor - hasAnyAnchoredLogs", () => {
  it("is false on a fresh dir and true after anchoring", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "kit-anchor-has-"));
    const dir = mkdtempSync(join(tmpdir(), "kit-anchor-hash-"));
    try {
      assert.equal(await hasAnyAnchoredLogs(dir), false);
      const content = await buildChain(cwd, 2);
      await anchorAuditLog(join(cwd, ".kit-audit.jsonl"), content, dir);
      assert.equal(await hasAnyAnchoredLogs(dir), true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("audit anchor - external anchor extension point", () => {
  it("resolveExternalAnchor returns null until an enclave wires one up", () => {
    assert.equal(resolveExternalAnchor(), null);
  });
});
