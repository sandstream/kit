import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPreTrusted, claudeTrusts, codexTrusts, pathKey } from "./check-pretrusted.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const SECRETISH = "sk-fixture-not-a-real-value";

function dirs(t: { after(fn: () => void): void }): { root: string; home: string } {
  const base = mkdtempSync(join(tmpdir(), "kit-pretrust-"));
  t.after(() => rmTemp(base));
  const root = join(base, "project");
  const home = join(base, "home");
  mkdirSync(root, { recursive: true });
  mkdirSync(join(home, ".codex"), { recursive: true });
  return { root, home };
}

function claudeJson(root: string, accepted: boolean): string {
  return JSON.stringify({
    primaryApiKey: SECRETISH,
    projects: {
      [root]: { hasTrustDialogAccepted: accepted, mcpServers: {}, history: [SECRETISH] },
      "/somewhere/else": { hasTrustDialogAccepted: true },
    },
  });
}

/** A TOML basic string for a path: backslashes and quotes escaped, as Codex writes it. */
const tomlString = (p: string) => JSON.stringify(p);

describe("pathKey", () => {
  it("compares Windows paths case-insensitively with either separator", () => {
    assert.equal(pathKey("C:\\Users\\Me\\Repo\\", "win32"), pathKey("c:/users/me/repo", "win32"));
    assert.notEqual(pathKey("/Users/Me/Repo", "linux"), pathKey("/users/me/repo", "linux"));
  });
});

describe("claudeTrusts and codexTrusts", () => {
  const keys = new Set([pathKey("/work/repo")]);

  it("reads hasTrustDialogAccepted for this path only", () => {
    assert.equal(claudeTrusts(claudeJson("/work/repo", true), keys), true);
    assert.equal(claudeTrusts(claudeJson("/work/repo", false), keys), false);
    assert.equal(claudeTrusts(claudeJson("/work/other", true), keys), false);
    assert.equal(claudeTrusts("{not json", keys), false);
  });

  it("reads trust_level in this path's [projects] table only", () => {
    const toml = [
      'model = "x"',
      '[projects."/work/other"]',
      'trust_level = "trusted"',
      "[projects.'/work/repo']",
      'trust_level = "untrusted"',
    ].join("\n");
    assert.equal(codexTrusts(toml, keys), false);
    assert.equal(codexTrusts('[projects."/work/repo"]\ntrust_level = "trusted"\n', keys), true);
    assert.equal(
      codexTrusts('[projects."/work/repo"]\n[mcp_servers.x]\ntrust_level = "trusted"\n', keys),
      false,
    );
  });
});

describe("checkPreTrusted", () => {
  it("names Claude Code when ~/.claude.json pre-trusts the repository, and nothing else", (t) => {
    const { root, home } = dirs(t);
    writeFileSync(join(home, ".claude.json"), claudeJson(root, true));
    const rows = checkPreTrusted(root, home, {});
    assert.equal(rows.length, 1);
    assert.match(rows[0].detail, /Claude Code \(~\/\.claude\.json/);
    assert.doesNotMatch(rows[0].detail, /Codex/);
    const shown = JSON.stringify(rows);
    assert.ok(!shown.includes(SECRETISH), "no other content of the file is printed");
    assert.ok(!shown.includes("/somewhere/else"));
  });

  it("names Codex when config.toml marks the repository trusted", (t) => {
    const { root, home } = dirs(t);
    writeFileSync(
      join(home, ".codex", "config.toml"),
      `api_key = "${SECRETISH}"\n[projects.${tomlString(root)}]\ntrust_level = "trusted"\n`,
    );
    const rows = checkPreTrusted(root, home, {});
    assert.equal(rows.length, 1);
    assert.match(rows[0].detail, /Codex \(~\/\.codex\/config\.toml/);
    assert.ok(!JSON.stringify(rows).includes(SECRETISH));
  });

  it("reads $CODEX_HOME and $CLAUDE_CONFIG_DIR when they are set", (t) => {
    const { root, home } = dirs(t);
    const codex = join(home, "codex-elsewhere");
    const claude = join(home, "claude-elsewhere");
    mkdirSync(codex);
    mkdirSync(claude);
    writeFileSync(
      join(codex, "config.toml"),
      `[projects.${tomlString(root)}]\ntrust_level = "trusted"\n`,
    );
    writeFileSync(join(claude, ".claude.json"), claudeJson(root, true));
    const rows = checkPreTrusted(root, home, { CODEX_HOME: codex, CLAUDE_CONFIG_DIR: claude });
    assert.match(rows[0].detail, /\$CLAUDE_CONFIG_DIR\/\.claude\.json/);
    assert.match(rows[0].detail, /\$CODEX_HOME\/config\.toml/);
  });

  it("is quiet when no tool trusts the repository", (t) => {
    const { root, home } = dirs(t);
    writeFileSync(join(home, ".claude.json"), claudeJson(root, false));
    writeFileSync(join(home, ".codex", "config.toml"), 'model = "x"\n');
    assert.deepEqual(checkPreTrusted(root, home, {}), []);
  });

  it("is quiet when the files are missing", (t) => {
    const { root, home } = dirs(t);
    assert.deepEqual(checkPreTrusted(root, home, {}), []);
  });
});
