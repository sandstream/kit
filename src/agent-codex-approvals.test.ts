/**
 * Codex with approvals or the sandbox off in saved config. `kit agent-audit` named Claude Code's
 * `defaultMode: "bypassPermissions"` ("write access without confirmation: main session") and gave
 * no row for the Codex equivalent (kit-research `agent-vm-yolo-herdr-paseo-vs-kit`). Keys and layers verified against
 * https://developers.openai.com/codex/config-reference (`approval_policy`: `on-request | never`,
 * `sandbox_mode`: `read-only | workspace-write | danger-full-access`, `default_permissions`
 * built-in `:danger-full-access`) and https://developers.openai.com/codex/config-advanced
 * (`--profile <name>` overlays `~/.codex/<name>.config.toml`; `[profiles.<name>]` in
 * `config.toml` before 0.134.0; Codex ignores `profiles` in a project `.codex/config.toml`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { codexApprovalsOff, runCodexApprovals } from "./agent-codex-approvals.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

function fixture(t: { after(fn: () => void): void }, files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "kit-codex-approvals-"));
  t.after(() => rmTemp(dir));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, ...rel.split("/"));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  mkdirSync(join(dir, "proj"), { recursive: true });
  mkdirSync(join(dir, "home"), { recursive: true });
  return { root: join(dir, "proj"), home: join(dir, "home") };
}

const BOTH = 'approval_policy = "never"\nsandbox_mode = "danger-full-access"\n';

describe("codexApprovalsOff", () => {
  it("reads never, danger-full-access and the :danger-full-access profile", () => {
    assert.deepEqual(codexApprovalsOff({ approval_policy: "on-request" }).keys, []);
    assert.deepEqual(
      codexApprovalsOff({ approval_policy: { granular: { rules: false } } }).keys,
      [],
    );
    const off = codexApprovalsOff(
      { default_permissions: ":danger-full-access" },
      {
        approval_policy: "never",
      },
    );
    assert.deepEqual([off.approvals, off.sandbox], [true, true]);
  });
});

describe("runCodexApprovals", () => {
  it("names user, legacy profile, profile file and project layers", (t) => {
    const s = fixture(t, {
      "home/.codex/config.toml": `approval_policy = "never"\n[profiles.yolo]\nsandbox_mode = "danger-full-access"\n`,
      "home/.codex/ci.config.toml": 'sandbox_mode = "danger-full-access"\n',
      "home/.codex/safe.config.toml": 'approval_policy = "on-request"\n',
      "proj/.codex/config.toml": BOTH,
    });
    const rows = runCodexApprovals(s.root, s.home, {});
    const by = new Map(rows.map((r) => [r.name, r]));
    assert.equal(by.get("approvals off: Codex ~/.codex/config.toml")?.severity, "low");
    const legacy = by.get(
      "write access without confirmation: Codex ~/.codex/config.toml [profiles.yolo]",
    );
    assert.equal(legacy?.severity, "medium");
    assert.equal(
      by.get("write access without confirmation: Codex ~/.codex/ci.config.toml (--profile ci)")
        ?.status,
      "warn",
    );
    assert.match(
      by.get("write access without confirmation: Codex .codex/config.toml")?.detail ?? "",
      /approval_policy = "never" and sandbox_mode = "danger-full-access".*bypassPermissions/,
    );
    assert.equal(rows.length, 4, rows.map((r) => r.name).join("\n"));
  });

  it("reads $CODEX_HOME and stays silent on a safe config", (t) => {
    const s = fixture(t, { "cx/config.toml": 'sandbox_mode = "danger-full-access"\n' });
    const env = { CODEX_HOME: join(dirname(s.home), "cx") };
    const rows = runCodexApprovals(s.root, s.home, env);
    assert.deepEqual(
      rows.map((r) => r.name),
      ["sandbox off: Codex $CODEX_HOME/config.toml"],
    );
    const quiet = fixture(t, { "proj/.codex/config.toml": 'approval_policy = "on-request"\n' });
    assert.deepEqual(runCodexApprovals(quiet.root, quiet.home, {}), []);
  });
});

describe("kit agent-audit", () => {
  it("reports a project Codex config with approvals and sandbox off", (t) => {
    const s = fixture(t, { "proj/.codex/config.toml": BOTH });
    const cli = resolve(dirname(fileURLToPath(import.meta.url)), "cli.js");
    const r = spawnSync(process.execPath, [cli, "agent-audit", "--json"], {
      cwd: s.root,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: s.home,
        USERPROFILE: s.home,
        KIT_NO_UPDATE_CHECK: "1",
        KIT_AUDIT_ANCHOR: "0",
        CODEX_HOME: "",
        CLAUDE_CONFIG_DIR: "",
      },
      timeout: 60_000,
    });
    const results = (JSON.parse(r.stdout) as { results: { name: string }[] }).results;
    assert.ok(
      results.some((x) => x.name === "write access without confirmation: Codex .codex/config.toml"),
      results.map((x) => x.name).join("\n"),
    );
  });
});
