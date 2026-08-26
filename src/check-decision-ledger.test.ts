/**
 * The four states of the ledger gate, and the line between them.
 *
 *   - **nobody asked for a ledger** → skip with the command that adopts one. Opt-in by
 *     construction, same as the advisory baseline: warning about a choice nobody has made is noise.
 *   - **required, and absent** → `didNotRun`. This is the whole point of step 1: a governed run
 *     that produced no ledger has no review surface, and `gateStatus` fails `didNotRun` by default
 *     so that green means something actually ran. An empty file is the same condition as a missing
 *     one — a ledger with no entries records no decisions.
 *   - **present but malformed** → a plain fail, NOT `didNotRun`. The check ran; it found a hole.
 *     The distinction matters because `--lenient` downgrades the second kind and not this one.
 *   - **present and well-formed** → pass, with the counts that make the size visible.
 *
 * And the invariant that outlives all four: content is never gated. A ledger of shallow decisions
 * passes, because the moment kit scores the reasoning, the auditor separation is gone.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkDecisionLedger } from "./check-decision-ledger.js";
import { gateStatus, type SecurityCheckResult } from "./check-security.js";
import { DECISION_LEDGER_FILE } from "./decision-ledger.js";

const entry = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    id: "a1b2c3",
    at: "2026-08-24T09:00:00.000Z",
    decision: "kept the ledger out of the audit log",
    confidence: 0.6,
    assumed: "per-run artifacts do not need the chain",
    would_have_asked: "should the ledger survive across runs?",
    reviewed: false,
    ...over,
  });

function repo(lines?: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-ledger-"));
  if (lines) {
    mkdirSync(join(dir, ".kit"), { recursive: true });
    writeFileSync(join(dir, DECISION_LEDGER_FILE), lines.join("\n"));
  }
  return dir;
}

describe("checkDecisionLedger", () => {
  it("skips when no ledger is required and none exists", async () => {
    const dir = repo();
    try {
      const r = await checkDecisionLedger(dir, false);
      assert.equal(r.status, "skip");
      assert.notEqual(r.didNotRun, true);
      assert.match(r.detail, /kit decisions/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails as didNotRun when a ledger is required and absent", async () => {
    const dir = repo();
    try {
      const r = await checkDecisionLedger(dir, true);
      assert.equal(r.status, "fail");
      assert.equal(r.didNotRun, true);
      assert.match(r.detail, /no \.kit\/decisions\.jsonl/);
      assert.equal(gateStatus(r), "fail");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats an empty ledger as the same hole as a missing one", async () => {
    const dir = repo(["", "  "]);
    try {
      const r = await checkDecisionLedger(dir, true);
      assert.equal(r.status, "fail");
      assert.equal(r.didNotRun, true);
      assert.match(r.detail, /no decisions recorded/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes a well-formed required ledger and counts what is unreviewed", async () => {
    const dir = repo([entry(), entry({ id: "b2", reviewed: true })]);
    try {
      const r = await checkDecisionLedger(dir, true);
      assert.equal(r.status, "pass");
      assert.match(r.detail, /2 decision/);
      assert.match(r.detail, /1 unreviewed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails a malformed entry, naming the line and the field — and it is not didNotRun", async () => {
    const dir = repo([entry(), entry({ id: "b2", confidence: "high" })]);
    try {
      const r = await checkDecisionLedger(dir, true);
      assert.equal(r.status, "fail");
      assert.notEqual(r.didNotRun, true, "the check ran; it found a hole");
      assert.match(r.detail, /line 2/);
      assert.match(r.detail, /confidence/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("verifies a ledger that exists even when nothing required one", async () => {
    const dir = repo([entry({ decision: "" })]);
    try {
      const r = await checkDecisionLedger(dir, false);
      assert.equal(r.status, "fail");
      assert.match(r.detail, /decision/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes a shallow decision — the gate is on shape, never on content", async () => {
    const dir = repo([
      entry({ decision: "did the usual thing", assumed: "nothing", would_have_asked: "nothing" }),
    ]);
    try {
      const r = await checkDecisionLedger(dir, true);
      assert.equal(r.status, "pass");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a ledger it cannot read as didNotRun, never as a clean ledger", async () => {
    const dir = repo();
    // A directory where the file should be: the read fails with something other than ENOENT.
    mkdirSync(join(dir, DECISION_LEDGER_FILE), { recursive: true });
    try {
      const r = await checkDecisionLedger(dir, true);
      assert.equal(r.status, "fail");
      assert.equal(r.didNotRun, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("names how many entries are unreadable rather than only the first", async () => {
    const dir = repo([entry(), "{torn", entry({ id: "c3", at: "nope" })]);
    try {
      const r = await checkDecisionLedger(dir, true);
      assert.equal(r.status, "fail");
      assert.match(r.detail, /2 of 3/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * The wiring, proved rather than assumed. A check that exists and is never called reads exactly
 * like a check that passes — `kit check` would print no row and the gate would stay green while
 * the ledger requirement did nothing. So this drives the real `checkSecurity` assembly and asserts
 * the row is in it, and that `[decisions] require` is what turns it from a skip into a gate.
 */
describe("decision ledger, wired into checkSecurity", () => {
  const envKeys = [
    "KIT_AUDIT_ANCHOR",
    "KIT_BUMBLEBEE",
    "KIT_CLAUDE_SETTINGS",
    "KIT_CODEX_HOOKS",
    "KIT_CODEX_MEMORY_HOOK_MARKER",
    "KIT_GUARDDOG",
    "KIT_MEMORY_DB",
    "KIT_MEMORY_DIR",
    "KIT_MEMORY_HOOK_MARKER",
    "KIT_NO_DOWNLOAD",
  ] as const;

  async function securityRowFor(kitToml: string | null): Promise<SecurityCheckResult | undefined> {
    const { checkSecurity } = await import("./check-security.js");
    const dir = mkdtempSync(join(tmpdir(), "kit-ledger-wiring-"));
    const state = join(dir, ".kit-test-agent-state");
    mkdirSync(state, { recursive: true });
    if (kitToml !== null) writeFileSync(join(dir, ".kit.toml"), kitToml);
    const prev = new Map<string, string | undefined>();
    for (const key of envKeys) prev.set(key, process.env[key]);
    process.env.KIT_AUDIT_ANCHOR = "0";
    process.env.KIT_BUMBLEBEE = "0";
    process.env.KIT_CLAUDE_SETTINGS = join(state, "claude-settings.json");
    process.env.KIT_CODEX_HOOKS = join(state, "codex-hooks.json");
    process.env.KIT_CODEX_MEMORY_HOOK_MARKER = join(state, "codex-marker");
    process.env.KIT_GUARDDOG = "0";
    process.env.KIT_MEMORY_DB = join(state, "memory.db");
    process.env.KIT_MEMORY_DIR = state;
    process.env.KIT_MEMORY_HOOK_MARKER = join(state, "claude-marker");
    process.env.KIT_NO_DOWNLOAD = "1";
    try {
      const results = await checkSecurity(dir);
      return results.find((r) => r.name === "decision ledger");
    } finally {
      for (const key of envKeys) {
        const value = prev.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("appears as a row even when no ledger is required", async () => {
    const row = await securityRowFor(null);
    assert.ok(row, "the check must be wired into the assembly, not merely exported");
    assert.equal(row.status, "skip");
  });

  it("gates the run when [decisions] require = true", async () => {
    const row = await securityRowFor("[decisions]\nrequire = true\n");
    assert.ok(row);
    assert.equal(row.status, "fail");
    assert.equal(row.didNotRun, true);
  });
});
