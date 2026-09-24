import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cmdTriage,
  parseStagedSkillNames,
  latestDeepSkillTriage,
  missingDeepSkillTriage,
} from "./triage.js";
import { installBundledTriageSkill } from "../triage.js";

// Only the honest-skip path of `kit triage plugin` is exercised here — the happy path calls the
// live npm registry triage (network), which is out of scope for a unit test.
describe("kit triage plugin (no plugins declared → honest skip)", () => {
  let dir: string;
  let cwd: string;
  let argv: string[];
  let logs: string[];
  let origLog: typeof console.log;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kit-triage-plugin-"));
    cwd = process.cwd();
    process.chdir(dir);
    argv = process.argv;
    logs = [];
    origLog = console.log;
    console.log = (...a: unknown[]) => void logs.push(a.join(" "));
  });

  afterEach(() => {
    process.chdir(cwd);
    process.argv = argv;
    console.log = origLog;
    rmSync(dir, { recursive: true, force: true });
  });

  it("skips cleanly (exit 0) when package.json has no kitPlugins", async () => {
    process.argv = ["node", "kit", "triage", "plugin"];
    const ok = await cmdTriage();
    assert.equal(ok, true);
    assert.match(logs.join("\n"), /no kitPlugins declared/);
  });
});

// A triage-log entry shaped like the ones recordTriageRun writes.
const logEntry = (o: { target: string; deep?: boolean; type?: string; timestamp?: string }) => ({
  timestamp: o.timestamp ?? "2026-07-10T12:00:00Z",
  type: o.type ?? "skill",
  target: o.target,
  sandbox: false,
  deep: o.deep,
  granter: "tester",
});

describe("check-skills gate — parseStagedSkillNames", () => {
  it("extracts unique skill names from staged files inside .claude/skills/<name>/", () => {
    const names = parseStagedSkillNames([
      ".claude/skills/searxng/SKILL.md",
      ".claude/skills/searxng/scripts/run.sh",
      ".claude/skills/triage/SKILL.md",
      "src/unrelated.ts",
      ".claude/skills/README.md", // a file directly in skills/, not inside a skill dir
      "",
    ]);
    assert.deepEqual(names.sort(), ["searxng", "triage"]);
  });

  it("returns [] when no skill files are staged", () => {
    assert.deepEqual(parseStagedSkillNames(["package.json", "src/x.ts"]), []);
  });
});

describe("check-skills gate — latestDeepSkillTriage", () => {
  const NOW = Date.parse("2026-07-11T12:00:00Z");

  it("counts only type:skill + deep:true, keeps the most recent, normalizes path targets", () => {
    const latest = latestDeepSkillTriage([
      logEntry({ target: ".claude/skills/searxng", deep: true, timestamp: "2026-07-05T00:00:00Z" }),
      logEntry({ target: "searxng", deep: true, timestamp: "2026-07-09T00:00:00Z" }), // newer
      logEntry({ target: "searxng", deep: false, timestamp: "2026-07-10T00:00:00Z" }), // shallow — ignored
      logEntry({ target: "express", deep: true, type: "npm" }), // not a skill — ignored
    ]);
    assert.equal(latest.size, 1);
    assert.equal(latest.get("searxng"), Date.parse("2026-07-09T00:00:00Z"));
  });

  it("drops entries with a forged/unparseable timestamp (never counts as fresh)", () => {
    const latest = latestDeepSkillTriage([
      logEntry({ target: "searxng", deep: true, timestamp: "not-a-date" }),
    ]);
    assert.equal(latest.has("searxng"), false);
    // and such a skill therefore reads as missing
    assert.deepEqual(
      missingDeepSkillTriage(
        ["searxng"],
        [logEntry({ target: "searxng", deep: true, timestamp: "not-a-date" })],
        NOW,
      ),
      ["searxng"],
    );
  });
});

describe("check-skills gate — missingDeepSkillTriage (fail-closed)", () => {
  const NOW = Date.parse("2026-07-11T12:00:00Z");

  it("a fresh deep entry satisfies the gate (path-form target matches the skill name)", () => {
    const entries = [
      logEntry({ target: ".claude/skills/searxng", deep: true, timestamp: "2026-07-10T00:00:00Z" }),
    ];
    assert.deepEqual(missingDeepSkillTriage(["searxng"], entries, NOW), []);
  });

  it("a shallow-only entry does NOT satisfy the deep gate", () => {
    const entries = [
      logEntry({ target: "searxng", deep: false, timestamp: "2026-07-10T00:00:00Z" }),
    ];
    assert.deepEqual(missingDeepSkillTriage(["searxng"], entries, NOW), ["searxng"]);
  });

  it("a stale deep entry (older than the max age) does NOT satisfy the gate", () => {
    const entries = [
      logEntry({ target: "searxng", deep: true, timestamp: "2026-06-01T00:00:00Z" }),
    ];
    assert.deepEqual(missingDeepSkillTriage(["searxng"], entries, NOW), ["searxng"]);
  });

  it("no triage log at all ⇒ every staged skill is missing", () => {
    assert.deepEqual(missingDeepSkillTriage(["a", "b"], [], NOW).sort(), ["a", "b"]);
  });

  it("mixes satisfied and missing skills correctly", () => {
    const entries = [
      logEntry({ target: "searxng", deep: true, timestamp: "2026-07-10T00:00:00Z" }), // fresh deep
      logEntry({ target: "triage", deep: false, timestamp: "2026-07-10T00:00:00Z" }), // shallow
    ];
    assert.deepEqual(missingDeepSkillTriage(["searxng", "triage", "new"], entries, NOW).sort(), [
      "new",
      "triage",
    ]);
  });
});

// RED-1: `kit triage <type> <target>` echoes the target back before running the
// real probe. A target can legitimately carry a credential (`kit triage repo
// https://u:ghp_xxx@host/owner/repo`), so that echo must not leak it.
describe("kit triage <type> <target> never echoes an embedded credential (RED-1)", () => {
  let dir: string;
  let cwd: string;
  let argv: string[];
  let logs: string[];
  let origLog: typeof console.log;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kit-triage-redact-"));
    cwd = process.cwd();
    process.chdir(dir);
    argv = process.argv;
    logs = [];
    origLog = console.log;
    console.log = (...a: unknown[]) => void logs.push(a.join(" "));
  });

  afterEach(() => {
    process.chdir(cwd);
    process.argv = argv;
    console.log = origLog;
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not print the token embedded in a `triage repo` target", async () => {
    // Force-refresh the installed skill copy from THIS checkout: ensureTriageScript()
    // only refreshes on a kit-version mismatch, so a same-version, mid-development edit
    // to the bundled triage.py (this fix, pre-release) would otherwise silently run
    // whatever was already installed on the machine running the test.
    await installBundledTriageSkill();
    const token = `ghp_${"A".repeat(40)}`;
    process.argv = [
      "node",
      "kit",
      "triage",
      "repo",
      `https://u:${token}@github.com/nonexistent-owner-1234/nonexistent-repo-5678`,
    ];
    await cmdTriage();
    const output = logs.join("\n");
    assert.match(output, /Running triage on repo/);
    assert.ok(!output.includes(token), `output must not leak the token: ${output}`);
  });
});
