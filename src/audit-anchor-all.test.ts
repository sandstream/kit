/**
 * The union view has to be right about the machine, not about a fixture.
 *
 * Trap 5 from the enforcement arc applies directly here: a correct classifier with no
 * caller is not a working control, and #470 is *itself* an instance of that — the
 * anchor record was correct, complete, 0600, and read by nothing. So the pure-function
 * tests below are followed by end-to-end runs of the compiled CLI against a real
 * `~/.kit`-shaped anchor dir holding real hash-chained logs in four states, asserting
 * on the command's own stdout and exit code.
 *
 * The four states are the ones that matter for readability: a sealed tree that
 * verifies, a tree with entries appended past its seal (`stalled`), a log path that no
 * longer exists (`missing` — the common case on a dev machine, 12 of the 15 paths
 * measured in #470), and a log whose sealed prefix was replaced by a differently-keyed
 * valid chain (`failed`). If `missing` and `stalled` ever collapse into one outcome the
 * report stops being readable, so that split is asserted explicitly.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { appendAuditEventDirect } from "./audit.js";
import { anchorAuditLog, getAuditAnchorKey, type AnchorRecord } from "./audit-anchor.js";
import {
  classifyAnchoredLog,
  summarizeAnchoredLogs,
  verifyAnchoredLogs,
  readLogForUnion,
  type AnchoredLogStatus,
  type LogRead,
} from "./audit-anchor-all.js";

const exec = promisify(execFile);
const CLI_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "cli.js");
const LOG = ".kit-audit.jsonl";

const record = (over: Partial<AnchorRecord> = {}): AnchorRecord => ({
  tip: "00".repeat(32),
  count: 2,
  algo: "hmac-sha256",
  updatedAt: "2026-08-20T00:00:00.000Z",
  version: 3,
  ...over,
});

const gone: LogRead = { ok: false, gone: true };
const unreadable: LogRead = { ok: false, gone: false };

/** Build a real hash-chained log in `cwd` without auto-anchoring (KIT_AUDIT_ANCHOR=0). */
async function buildChain(cwd: string, n: number, tag = "op"): Promise<string> {
  for (let i = 0; i < n; i++) {
    const ok = await appendAuditEventDirect(
      { operation: `${tag}-${i}`, environment: "dev", success: true },
      { cwd },
    );
    assert.equal(ok, true);
  }
  return readFileSync(join(cwd, LOG), "utf-8");
}

describe("audit union view - classification", () => {
  let dirs: string[] = [];
  const mk = (): string => {
    const d = realpathSync(mkdtempSync(join(tmpdir(), "kit-union-")));
    dirs.push(d);
    return d;
  };

  beforeEach(() => {
    dirs = [];
  });
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it("a log path that is gone reads as missing, never as a finding", () => {
    const s = classifyAnchoredLog("/tmp/kit-test-1234/.kit-audit.jsonl", record(), gone, null);
    assert.equal(s.outcome, "missing");
    assert.equal(s.detail, "log-gone");
    assert.equal(s.sealed, 2);
    assert.equal(s.sealedAt, "2026-08-20T00:00:00.000Z");
    // The message has to say why it is not an alarm, or the reader treats it as one.
    assert.match(s.message, /temp dir|deleted clone/);
  });

  it("a log that exists but cannot be read fails closed, distinct from gone", () => {
    const s = classifyAnchoredLog("/root/locked/.kit-audit.jsonl", record(), unreadable, null);
    assert.equal(s.outcome, "failed");
    assert.equal(s.detail, "unreadable");
    assert.match(s.message, /could not be read/);
  });

  it("a sealed log with nothing past the seal verifies", async () => {
    const anchorHome = mk();
    const tree = mk();
    const content = await buildChain(tree, 3);
    const rec = await anchorAuditLog(join(tree, LOG), content, anchorHome);
    const key = await getAuditAnchorKey(anchorHome);

    const s = classifyAnchoredLog(join(tree, LOG), rec, { ok: true, content }, key);
    assert.equal(s.outcome, "verified");
    assert.equal(s.detail, "verified");
    assert.equal(s.entries, 3);
    assert.equal(s.sealed, 3);
    assert.equal(s.unsealed, 0);
  });

  it("entries appended past the seal read as stalled, with the tail counted", async () => {
    const anchorHome = mk();
    const tree = mk();
    const sealed = await buildChain(tree, 2);
    const rec = await anchorAuditLog(join(tree, LOG), sealed, anchorHome);
    const key = await getAuditAnchorKey(anchorHome);
    const grown = await buildChain(tree, 3, "later");

    const s = classifyAnchoredLog(join(tree, LOG), rec, { ok: true, content: grown }, key);
    assert.equal(s.outcome, "stalled");
    assert.equal(s.detail, "unsealed-tail");
    assert.equal(s.sealed, 2);
    assert.equal(s.entries, 5);
    assert.equal(s.unsealed, 3);
    assert.match(s.message, /kit audit anchor/);
  });

  it("a broken hash chain fails as chain-broken, before any tip comparison", async () => {
    const anchorHome = mk();
    const tree = mk();
    const content = await buildChain(tree, 3);
    const rec = await anchorAuditLog(join(tree, LOG), content, anchorHome);
    const key = await getAuditAnchorKey(anchorHome);

    const lines = content.trim().split("\n");
    const edited = JSON.parse(lines[1]) as Record<string, unknown>;
    edited.operation = "rewritten-in-place";
    lines[1] = JSON.stringify(edited);

    const s = classifyAnchoredLog(
      join(tree, LOG),
      rec,
      { ok: true, content: lines.join("\n") },
      key,
    );
    assert.equal(s.outcome, "failed");
    assert.equal(s.detail, "chain-broken");
    assert.equal(s.sealed, 3);
  });

  it("a shorter log than the seal covers fails as truncated", async () => {
    const anchorHome = mk();
    const tree = mk();
    const content = await buildChain(tree, 4);
    const rec = await anchorAuditLog(join(tree, LOG), content, anchorHome);
    const key = await getAuditAnchorKey(anchorHome);
    const rolledBack = content.trim().split("\n").slice(0, 2).join("\n") + "\n";

    const s = classifyAnchoredLog(join(tree, LOG), rec, { ok: true, content: rolledBack }, key);
    assert.equal(s.outcome, "failed");
    assert.equal(s.detail, "truncated");
  });

  it("a valid chain that is not the sealed one fails as tip-mismatch", async () => {
    const anchorHome = mk();
    const treeA = mk();
    const treeB = mk();
    const sealedContent = await buildChain(treeA, 3, "real");
    const rec = await anchorAuditLog(join(treeA, LOG), sealedContent, anchorHome);
    const key = await getAuditAnchorKey(anchorHome);
    // A writer-only attacker re-chains a substitute history: chain verifies, tip cannot.
    const forged = await buildChain(treeB, 3, "forged");

    const s = classifyAnchoredLog(join(treeA, LOG), rec, { ok: true, content: forged }, key);
    assert.equal(s.outcome, "failed");
    assert.equal(s.detail, "tip-mismatch");
  });

  it("an unreadable anchor key fails closed instead of reporting verified", async () => {
    const anchorHome = mk();
    const tree = mk();
    const content = await buildChain(tree, 2);
    const rec = await anchorAuditLog(join(tree, LOG), content, anchorHome);

    const s = classifyAnchoredLog(join(tree, LOG), rec, { ok: true, content }, null);
    assert.equal(s.outcome, "failed");
    assert.equal(s.detail, "key-unavailable");
  });

  it("a rotated anchor key reads as stalled (re-seal), not as tamper", async () => {
    const anchorHome = mk();
    const tree = mk();
    const content = await buildChain(tree, 2);
    const rec = await anchorAuditLog(join(tree, LOG), content, anchorHome);
    const otherKey = Buffer.alloc(32, 9);

    const s = classifyAnchoredLog(join(tree, LOG), rec, { ok: true, content }, otherKey);
    assert.equal(s.outcome, "stalled");
    assert.equal(s.detail, "anchor-key-changed");
  });

  it("readLogForUnion splits gone from present", async () => {
    const tree = mk();
    await buildChain(tree, 1);
    const present = await readLogForUnion(join(tree, LOG));
    assert.equal(present.ok, true);
    const absent = await readLogForUnion(join(tree, "no-such-log.jsonl"));
    assert.equal(absent.ok, false);
    assert.equal(absent.ok === false && absent.gone, true);
  });
});

describe("audit union view - verdict policy", () => {
  const status = (over: Partial<AnchoredLogStatus>): AnchoredLogStatus => ({
    logPath: "/x/.kit-audit.jsonl",
    outcome: "verified",
    detail: "verified",
    message: "ok",
    ...over,
  });

  it("missing paths never fail the verdict, at any count", () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      status({ logPath: `/tmp/t-${i}/.kit-audit.jsonl`, outcome: "missing", detail: "log-gone" }),
    );
    for (const strict of [false, true]) {
      const r = summarizeAnchoredLogs([...many, status({})], strict);
      assert.equal(r.ok, true, `strict=${strict}`);
      assert.equal(r.counts.missing, 12);
      assert.equal(r.counts.verified, 1);
    }
  });

  it("a stalled seal warns by default and fails under strict", () => {
    const rows = [status({}), status({ outcome: "stalled", detail: "unsealed-tail" })];
    assert.equal(summarizeAnchoredLogs(rows, false).ok, true);
    assert.equal(summarizeAnchoredLogs(rows, true).ok, false);
  });

  it("one failed path fails the verdict even among verified ones", () => {
    const rows = [status({}), status({ outcome: "failed", detail: "tip-mismatch" }), status({})];
    assert.equal(summarizeAnchoredLogs(rows, false).ok, false);
    assert.equal(summarizeAnchoredLogs(rows, false).counts.failed, 1);
  });

  it("an empty machine is not a pass claim (no counts, ok by absence of evidence)", () => {
    const r = summarizeAnchoredLogs([], false);
    assert.deepEqual(r.counts, { verified: 0, stalled: 0, missing: 0, failed: 0 });
    assert.equal(r.ok, true);
  });

  it("verifyAnchoredLogs walks every input and reports the union", async () => {
    const seen: string[] = [];
    const r = await verifyAnchoredLogs(
      [
        { logPath: "/a/.kit-audit.jsonl", record: record() },
        { logPath: "/b/.kit-audit.jsonl", record: record() },
      ],
      null,
      async (p) => {
        seen.push(p);
        return gone;
      },
    );
    assert.deepEqual(seen, ["/a/.kit-audit.jsonl", "/b/.kit-audit.jsonl"]);
    assert.equal(r.counts.missing, 2);
    assert.equal(r.strict, false);
  });
});

/**
 * End-to-end: the command, not the classifier. #470's defect was a correct data
 * structure nobody read, so these assert on what `kit audit verify --all` actually
 * prints and exits with, against a real anchor dir shared by four trees.
 */
describe("kit audit verify --all (compiled CLI)", () => {
  let anchorHome = "";
  let trees: string[] = [];

  const runCli = async (
    args: string[],
    cwd: string,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
    try {
      const { stdout, stderr } = await exec(process.execPath, [CLI_PATH, ...args], {
        cwd,
        env: {
          ...process.env,
          KIT_AUDIT_ANCHOR_DIR: anchorHome,
          // Keep incidental appends from advancing seals mid-assertion.
          KIT_AUDIT_ANCHOR: "0",
          KIT_HIDE_HOOK_SKIP_BANNER: "1",
        },
        timeout: 60_000,
      });
      return { exitCode: 0, stdout: stdout ?? "", stderr: stderr ?? "" };
    } catch (err: unknown) {
      const e = err as { code?: number; stdout?: string; stderr?: string };
      return {
        exitCode: typeof e.code === "number" ? e.code : 1,
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? "",
      };
    }
  };

  const mkTree = (): string => {
    const d = realpathSync(mkdtempSync(join(tmpdir(), "kit-union-cli-")));
    trees.push(d);
    return d;
  };

  beforeEach(() => {
    anchorHome = realpathSync(mkdtempSync(join(tmpdir(), "kit-union-home-")));
    trees = [];
  });
  afterEach(() => {
    rmSync(anchorHome, { recursive: true, force: true });
    for (const d of trees) rmSync(d, { recursive: true, force: true });
  });

  it("reports nothing sealed as a warning, not a green verdict", async () => {
    const tree = mkTree();
    const r = await runCli(["audit", "verify", "--all"], tree);
    assert.equal(r.exitCode, 0);
    assert.match(r.stderr + r.stdout, /sealed no audit log yet/);
    assert.doesNotMatch(r.stdout, /✓ 0 anchored/);
  });

  it("iterates every anchored path and separates missing from stalled", async () => {
    const verifiedTree = mkTree();
    const stalledTree = mkTree();
    const goneTree = mkTree();

    const vContent = await buildChain(verifiedTree, 2, "v");
    await anchorAuditLog(join(verifiedTree, LOG), vContent, anchorHome);

    const sSealed = await buildChain(stalledTree, 2, "s");
    await anchorAuditLog(join(stalledTree, LOG), sSealed, anchorHome);
    await buildChain(stalledTree, 2, "s-later");

    const gContent = await buildChain(goneTree, 1, "g");
    await anchorAuditLog(join(goneTree, LOG), gContent, anchorHome);
    rmSync(goneTree, { recursive: true, force: true });

    const r = await runCli(["audit", "verify", "--all", "--json"], verifiedTree);
    const report = JSON.parse(r.stdout) as {
      counts: Record<string, number>;
      ok: boolean;
      results: Array<{ logPath: string; outcome: string; detail: string; unsealed?: number }>;
    };

    assert.equal(report.results.length, 3, "all three anchored paths must be enumerated");
    const byPath = new Map(report.results.map((x) => [x.logPath, x]));
    assert.equal(byPath.get(join(verifiedTree, LOG))?.outcome, "verified");
    assert.equal(byPath.get(join(stalledTree, LOG))?.outcome, "stalled");
    assert.equal(byPath.get(join(stalledTree, LOG))?.unsealed, 2);
    assert.equal(byPath.get(join(goneTree, LOG))?.outcome, "missing");
    assert.deepEqual(report.counts, { verified: 1, stalled: 1, missing: 1, failed: 0 });
    // A vanished temp dir must not turn the whole machine red.
    assert.equal(report.ok, true);
    assert.equal(r.exitCode, 0);
  });

  it("--strict turns a stalled seal into a non-zero exit", async () => {
    const tree = mkTree();
    const sealed = await buildChain(tree, 1, "x");
    await anchorAuditLog(join(tree, LOG), sealed, anchorHome);
    await buildChain(tree, 1, "x-later");

    const lax = await runCli(["audit", "verify", "--all"], tree);
    assert.equal(lax.exitCode, 0);
    assert.match(lax.stdout + lax.stderr, /stalled/);

    const strict = await runCli(["audit", "verify", "--all", "--strict"], tree);
    assert.equal(strict.exitCode, 1);
  });

  it("a rewritten sealed prefix in ANOTHER tree fails the union verdict", async () => {
    const cwdTree = mkTree();
    const victim = mkTree();
    const forger = mkTree();

    const clean = await buildChain(cwdTree, 1, "clean");
    await anchorAuditLog(join(cwdTree, LOG), clean, anchorHome);

    const sealed = await buildChain(victim, 3, "real");
    await anchorAuditLog(join(victim, LOG), sealed, anchorHome);
    const forged = await buildChain(forger, 3, "forged");
    writeFileSync(join(victim, LOG), forged);

    // The cwd tree is clean: `kit audit verify` there passes and says nothing about
    // the victim. That green is exactly what #470 is about.
    const single = await runCli(["audit", "verify"], cwdTree);
    assert.equal(single.exitCode, 0);
    assert.doesNotMatch(single.stdout + single.stderr, new RegExp(victim.replace(/\+/g, "\\+")));

    const all = await runCli(["audit", "verify", "--all"], cwdTree);
    assert.equal(all.exitCode, 1);
    assert.match(all.stdout + all.stderr, /tip-mismatch/);
    assert.match(all.stdout + all.stderr, /1 failed/);
  });
});
