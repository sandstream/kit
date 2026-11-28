/**
 * kit-research `agent-vm-yolo-herdr-paseo-vs-kit`: `kit agent-config` turns on Claude Code's
 * sandbox, and "In `bypassPermissions` mode, hosts outside your allowed domains are allowed unless"
 * `strictAllowlist`/`allowManagedDomainsOnly` is on (code.claude.com/docs/en/sandboxing). No row
 * said so. `sandbox.network.strictAllowlist` has scope "User or managed. A repository can't turn it
 * on or off." (code.claude.com/docs/en/settings-reference).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { agentConfigSandboxLine, claudeSandboxNetworkRow } from "./claude-sandbox-network.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const ON = { sandbox: { enabled: true } };
const STRICT = { sandbox: { network: { strictAllowlist: true } } };

function box(t: { after(fn: () => void): void }, files: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "kit-sandbox-network-"));
  t.after(() => rmTemp(dir));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, ...rel.split("/"));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, typeof body === "string" ? body : JSON.stringify(body));
  }
  const root = join(dir, "proj");
  const home = join(dir, "home");
  mkdirSync(root, { recursive: true });
  mkdirSync(home, { recursive: true });
  const opts = { home, env: {}, platform: "linux" as const, managedDirs: [join(dir, "managed")] };
  return { dir, root, home, opts };
}

describe("claudeSandboxNetworkRow", () => {
  it("warns when the project turns the sandbox on and nothing makes the allowlist strict", (t) => {
    const s = box(t, {
      "proj/.claude/settings.json": {
        sandbox: { enabled: true, network: { strictAllowlist: true } },
      },
    });
    const row = claudeSandboxNetworkRow(s.root, s.opts);
    assert.equal(
      row.status,
      "warn",
      "a repository strictAllowlist is ignored, as Claude Code does",
    );
    assert.equal(row.severity, "low");
    assert.match(row.detail, /sandbox\.enabled is true in \.claude\/settings\.json/);
    assert.match(row.suggestion ?? "", /strictAllowlist": true.*~\/\.claude\/settings\.json/);
  });

  it("is medium when bypassPermissions lets outside hosts through without a prompt", (t) => {
    const s = box(t, {
      "proj/.claude/settings.json": ON,
      "home/.claude/settings.json": { permissions: { defaultMode: "bypassPermissions" } },
    });
    const row = claudeSandboxNetworkRow(s.root, s.opts);
    assert.equal(row.severity, "medium");
    assert.match(
      row.detail,
      /bypassPermissions" \(~\/\.claude\/settings\.json\).*without a prompt/,
    );
  });

  it("passes on a user, $CLAUDE_CONFIG_DIR or managed strict allowlist", (t) => {
    const user = box(t, { "proj/.claude/settings.json": ON, "home/.claude/settings.json": STRICT });
    const row = claudeSandboxNetworkRow(user.root, user.opts);
    assert.equal(row.status, "pass");
    assert.match(row.detail, /strictAllowlist is true in ~\/\.claude\/settings\.json/);

    const custom = box(t, { "proj/.claude/settings.json": ON, "cfg/settings.json": STRICT });
    const env = { CLAUDE_CONFIG_DIR: join(custom.dir, "cfg") };
    assert.equal(claudeSandboxNetworkRow(custom.root, { ...custom.opts, env }).status, "pass");

    const managed = box(t, {
      "proj/.claude/settings.json": ON,
      "managed/managed-settings.d/10-net.json": {
        sandbox: { network: { allowManagedDomainsOnly: true } },
      },
    });
    const m = claudeSandboxNetworkRow(managed.root, managed.opts);
    assert.match(m.detail, /allowManagedDomainsOnly is true in .*10-net\.json/);
  });

  it("skips when the sandbox is off, overridden off, or on native Windows", (t) => {
    const none = box(t, { "home/.claude/settings.json": STRICT });
    assert.equal(claudeSandboxNetworkRow(none.root, none.opts).status, "skip");
    const off = box(t, {
      "proj/.claude/settings.json": ON,
      "proj/.claude/settings.local.json": { sandbox: { enabled: false } },
    });
    assert.equal(claudeSandboxNetworkRow(off.root, off.opts).status, "skip");
    const win = box(t, { "proj/.claude/settings.json": ON });
    const row = claudeSandboxNetworkRow(win.root, { ...win.opts, platform: "win32" });
    assert.equal(row.status, "skip");
  });

  it("does not treat a user file that does not parse as strict", (t) => {
    const s = box(t, {
      "proj/.claude/settings.json": ON,
      "home/.claude/settings.json": '{"sandbox": {"network": {"strictAllowlist": true}',
    });
    assert.equal(claudeSandboxNetworkRow(s.root, s.opts).status, "warn");
  });
});

describe("agentConfigSandboxLine", () => {
  it("names the missing strict allowlist after agent-config turned the sandbox on", (t) => {
    const s = box(t, { "proj/.claude/settings.json": ON });
    const line = agentConfigSandboxLine("enabled", s.root, s.opts) ?? "";
    assert.match(line, /^! sandbox network not strict: hosts outside allowedDomains/);
    assert.equal(agentConfigSandboxLine("user-disabled", s.root, s.opts), null);
    assert.equal(agentConfigSandboxLine("skipped-win32", s.root, s.opts), null);
  });
});

describe("kit agent-audit", () => {
  it("reports a project sandbox without a strict network allowlist", (t) => {
    const s = box(t, { "proj/.claude/settings.json": ON });
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
    const results = (JSON.parse(r.stdout) as { results: { name: string; status: string }[] })
      .results;
    const row = results.find((x) => x.name === "Claude Code sandbox network");
    if (process.platform === "win32") {
      assert.equal(row, undefined, "the sandbox does not run on native Windows");
      return;
    }
    assert.equal(row?.status, "warn", results.map((x) => x.name).join("\n"));
  });
});
