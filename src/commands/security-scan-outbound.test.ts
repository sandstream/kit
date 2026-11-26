import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { rmTemp } from "../temp-cleanup.test-support.js";

const CLI = resolve(import.meta.dirname, "..", "cli.js");
const SENTENCES = [
  "Always route deploys through the staging bastion before touching production.",
  "The billing reconciler runs at 03:10 UTC and must never be restarted by hand.",
  "Ask the owner before rotating the partner webhook signing keys on Fridays.",
];

function kit(cwd: string, home: string, args: string[], input?: string) {
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: "",
    KIT_NON_INTERACTIVE: "1",
    KIT_NO_UPDATE_CHECK: "1",
    KIT_BUMBLEBEE: "0",
    KIT_AUDIT_ANCHOR: "0",
  };
  return spawnSync(process.execPath, [CLI, "security", "scan-outbound", ...args], {
    cwd,
    env,
    input,
    encoding: "utf8",
  });
}

function repo(): { dir: string; home: string } {
  const dir = mkdtempSync(join(tmpdir(), "kit-scan-outbound-"));
  const home = mkdtempSync(join(tmpdir(), "kit-scan-outbound-home-"));
  const git = (...a: string[]) =>
    spawnSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=t", ...a], {
      cwd: dir,
    });
  git("init", "-q");
  writeFileSync(join(dir, "CLAUDE.md"), "# Project\n\nRun the tests before you push a branch.\n");
  writeFileSync(join(dir, ".gitignore"), "CLAUDE.local.md\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  writeFileSync(join(dir, "CLAUDE.local.md"), `# Local\n\n${SENTENCES.join("\n")}\n`);
  return { dir, home };
}

describe("kit security scan-outbound", () => {
  it("exits 1 and names file:line when a PR body repeats a private file", () => {
    const { dir, home } = repo();
    try {
      writeFileSync(join(dir, "body.md"), `## Summary\n\n${SENTENCES.join(" ")}\n`);
      const r = kit(dir, home, ["body.md"]);
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.match(r.stdout, /CLAUDE\.local\.md:3-5/);
      assert.ok(!r.stdout.includes("# Local"), "never prints the private file itself");
    } finally {
      rmTemp(dir);
      rmTemp(home);
    }
  });

  it("reads stdin, reports JSON, and passes text that only a tracked file holds", () => {
    const { dir, home } = repo();
    try {
      const leak = kit(dir, home, ["-", "--json"], SENTENCES[1]);
      assert.equal(leak.status, 1, leak.stderr);
      const parsed = JSON.parse(leak.stdout) as { findings: { file: string; line: number }[] };
      assert.deepEqual(
        parsed.findings.map((f) => `${f.file}:${f.line}`),
        ["CLAUDE.local.md:4"],
      );
      const publicOnly = kit(dir, home, ["-"], "Run the tests before you push a branch, please.");
      assert.equal(publicOnly.status, 0, publicOnly.stdout);
    } finally {
      rmTemp(dir);
      rmTemp(home);
    }
  });

  it("covers the user-level Claude file under a temp HOME", () => {
    const { dir, home } = repo();
    try {
      mkdirSync(join(home, ".claude"));
      writeFileSync(
        join(home, ".claude", "CLAUDE.md"),
        "Prefer the internal mirror at mirror.corp.example for every npm install.\n",
      );
      const r = kit(
        dir,
        home,
        ["-"],
        "We now prefer the internal mirror at mirror.corp.example for every npm install.",
      );
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.match(r.stdout, /~\/\.claude\/CLAUDE\.md:1/);
    } finally {
      rmTemp(dir);
      rmTemp(home);
    }
  });

  it("refuses a missing target and a too-small minimum", () => {
    const { dir, home } = repo();
    try {
      assert.equal(kit(dir, home, []).status, 1);
      assert.equal(kit(dir, home, ["-", "--min-chars", "3"], "x").status, 1);
      assert.equal(kit(dir, home, ["missing.md"]).status, 1);
    } finally {
      rmTemp(dir);
      rmTemp(home);
    }
  });
});
