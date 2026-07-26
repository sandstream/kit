import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectHints } from "./hints.js";

// Isolate every external surface the detectors read so a test never depends on
// what's installed / present on the host: markers + identity + anchor store all
// point at fresh temp dirs.
function withEnv(fn: (repo: string, claudeDir: string) => void | Promise<void>): Promise<void> {
  const repo = mkdtempSync(join(tmpdir(), "kit-hints-repo-"));
  const home = mkdtempSync(join(tmpdir(), "kit-hints-home-"));
  const anchor = mkdtempSync(join(tmpdir(), "kit-hints-anchor-"));
  const ident = mkdtempSync(join(tmpdir(), "kit-hints-id-"));
  const claude = mkdtempSync(join(tmpdir(), "kit-hints-claude-"));
  const saved = {
    KIT_MEMORY_DIR: process.env.KIT_MEMORY_DIR,
    KIT_MEMORY_DB: process.env.KIT_MEMORY_DB,
    KIT_AUDIT_ANCHOR_DIR: process.env.KIT_AUDIT_ANCHOR_DIR,
    KIT_IDENTITY_DIR: process.env.KIT_IDENTITY_DIR,
    KIT_CLAUDE_DIR: process.env.KIT_CLAUDE_DIR,
    KIT_NO_HINTS: process.env.KIT_NO_HINTS,
    KIT_GUARDDOG: process.env.KIT_GUARDDOG,
  };
  process.env.KIT_MEMORY_DIR = home;
  process.env.KIT_AUDIT_ANCHOR_DIR = anchor;
  process.env.KIT_IDENTITY_DIR = ident; // empty → no identity → policy-init won't fire
  process.env.KIT_CLAUDE_DIR = claude; // empty → no transcripts → memory-unindexed won't fire
  delete process.env.KIT_MEMORY_DB;
  delete process.env.KIT_NO_HINTS;
  delete process.env.KIT_GUARDDOG;
  return Promise.resolve(fn(repo, claude)).finally(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    for (const d of [repo, home, anchor, ident, claude])
      rmSync(d, { recursive: true, force: true });
  });
}

const ids = (hs: { id: string }[]) => hs.map((h) => h.id);

describe("hints — deterministic contextual tips", () => {
  it("fires `policy-unsigned` for an unsigned .kit-policy.toml, then suppresses it (marker)", () =>
    withEnv(async (repo) => {
      writeFileSync(join(repo, ".kit-policy.toml"), "version = 1\nrequire_triage = true\n");
      const first = await collectHints(repo, { max: 5 });
      assert.ok(
        ids(first).includes("policy-unsigned"),
        `expected policy-unsigned, got ${ids(first)}`,
      );
      // shown once → gone on the next collection
      const second = await collectHints(repo, { max: 5 });
      assert.ok(!ids(second).includes("policy-unsigned"), "marker should suppress a second show");
    }));

  it("fires `audit-unanchored` for a non-empty, never-anchored audit log", () =>
    withEnv(async (repo) => {
      writeFileSync(
        join(repo, ".kit-audit.jsonl"),
        JSON.stringify({ operation: "x", hash: "a".repeat(64), prev: "0".repeat(64) }) + "\n",
      );
      const hs = await collectHints(repo, { max: 5 });
      assert.ok(ids(hs).includes("audit-unanchored"), `expected audit-unanchored, got ${ids(hs)}`);
    }));

  it("a clean repo yields no hints", () =>
    withEnv(async (repo) => {
      assert.deepEqual(await collectHints(repo, { max: 5 }), []);
    }));

  it("KIT_NO_HINTS silences everything", () =>
    withEnv(async (repo) => {
      writeFileSync(join(repo, ".kit-policy.toml"), "version = 1\n");
      process.env.KIT_NO_HINTS = "1";
      assert.deepEqual(await collectHints(repo, { max: 5 }), []);
    }));

  it("respects `max` and priority — audit (higher) before policy; one per call", () =>
    withEnv(async (repo) => {
      writeFileSync(join(repo, ".kit-policy.toml"), "version = 1\n");
      writeFileSync(
        join(repo, ".kit-audit.jsonl"),
        JSON.stringify({ operation: "x", hash: "b".repeat(64), prev: "0".repeat(64) }) + "\n",
      );
      const a = await collectHints(repo, { max: 1 });
      assert.deepEqual(ids(a), ["audit-unanchored"], "highest-priority rule first");
      const b = await collectHints(repo, { max: 1 });
      assert.deepEqual(ids(b), ["policy-unsigned"], "next call surfaces the next un-shown rule");
    }));

  it("markSeen:false does not write a marker (re-collectable)", () =>
    withEnv(async (repo) => {
      writeFileSync(join(repo, ".kit-policy.toml"), "version = 1\n");
      const a = await collectHints(repo, { max: 5, markSeen: false });
      assert.ok(ids(a).includes("policy-unsigned"));
      const b = await collectHints(repo, { max: 5, markSeen: false });
      assert.ok(ids(b).includes("policy-unsigned"), "without markSeen it stays collectable");
    }));

  // ── stack-aware rules: surface an existing kit capability at the moment the
  // repo's own state makes it relevant ─────────────────────────────────────────

  it("fires `gha-unaudited` when workflows exist; not for an empty workflows dir", () =>
    withEnv(async (repo) => {
      mkdirSync(join(repo, ".github", "workflows"), { recursive: true });
      assert.deepEqual(await collectHints(repo, { max: 5 }), [], "empty dir must not fire");
      writeFileSync(join(repo, ".github", "workflows", "ci.yml"), "on: push\n");
      const hs = await collectHints(repo, { max: 5 });
      assert.ok(ids(hs).includes("gha-unaudited"), `expected gha-unaudited, got ${ids(hs)}`);
    }));

  it("fires `baseline-unfrozen` only for a kit-managed repo with sources and no baseline", () =>
    withEnv(async (repo) => {
      mkdirSync(join(repo, "src"), { recursive: true });
      assert.deepEqual(await collectHints(repo, { max: 5 }), [], "no .kit.toml ⇒ no hint");
      writeFileSync(join(repo, ".kit.toml"), "# kit\n");
      const hs = await collectHints(repo, { max: 5, markSeen: false });
      assert.ok(
        ids(hs).includes("baseline-unfrozen"),
        `expected baseline-unfrozen, got ${ids(hs)}`,
      );
      writeFileSync(join(repo, ".kit-baseline.json"), "{}\n");
      assert.deepEqual(
        await collectHints(repo, { max: 5 }),
        [],
        "existing baseline must silence it",
      );
    }));

  it("fires `memory-unindexed` when transcripts exist but no store; store silences it", () =>
    withEnv(async (repo, claudeDir) => {
      mkdirSync(join(claudeDir, "projects", "-Users-x-proj"), { recursive: true });
      const hs = await collectHints(repo, { max: 5, markSeen: false });
      assert.ok(ids(hs).includes("memory-unindexed"), `expected memory-unindexed, got ${ids(hs)}`);
      // a memory store at the resolved db path silences the rule
      writeFileSync(join(process.env.KIT_MEMORY_DIR!, "memory.db"), "");
      assert.deepEqual(await collectHints(repo, { max: 5 }), []);
    }));
});
