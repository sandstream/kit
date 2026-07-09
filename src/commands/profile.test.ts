import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdProfile } from "./profile.js";
import { PROFILE_FILE } from "../profile/schema.js";

let dir: string;
let cwd: string;
let argv: string[];
let logs: string[];
let origLog: typeof console.log;
let origErr: typeof console.error;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kit-profile-cmd-"));
  cwd = process.cwd();
  process.chdir(dir);
  argv = process.argv;
  logs = [];
  origLog = console.log;
  origErr = console.error;
  console.log = (...a: unknown[]) => void logs.push(a.join(" "));
  console.error = (...a: unknown[]) => void logs.push(a.join(" "));
});

afterEach(() => {
  process.chdir(cwd);
  process.argv = argv;
  console.log = origLog;
  console.error = origErr;
  rmSync(dir, { recursive: true, force: true });
});

function setArgs(...sub: string[]): void {
  process.argv = ["node", "kit", "profile", ...sub];
}

describe("cmdProfile", () => {
  it("show skips honestly (exit 0, JSON) when no profile is declared", async () => {
    setArgs("show", "--json");
    const ok = await cmdProfile();
    assert.equal(ok, true);
    const out = JSON.parse(logs.join("\n"));
    assert.equal(out.skipped, true);
    assert.match(out.reason, /no profile/);
  });

  it("freeze snapshots the discovered toolchain into .kit-profile.toml", async () => {
    mkdirSync(join(dir, ".claude/skills/api-test"), { recursive: true });
    writeFileSync(join(dir, ".claude/skills/api-test/SKILL.md"), "# api-test\n");
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({ mcpServers: { postgres: { command: "npx x" } } }),
    );
    writeFileSync(join(dir, ".kit.toml"), `[secrets]\nstore = "1password"\n`);

    setArgs("freeze", "--json");
    const ok = await cmdProfile();
    assert.equal(ok, true);
    assert.ok(existsSync(join(dir, PROFILE_FILE)));
    const written = readFileSync(join(dir, PROFILE_FILE), "utf-8");
    assert.match(written, /api-test/);
    assert.match(written, /postgres/);
    assert.match(written, /1password/);
  });

  it("freeze preserves operator-authored sections (scope/workflows) verbatim", async () => {
    writeFileSync(
      join(dir, PROFILE_FILE),
      `version = 1\nname = "acme"\n[[workflows]]\nname = "release"\n[scope]\negress = ["api.acme.com"]\n`,
    );
    setArgs("freeze", "--json");
    const ok = await cmdProfile();
    assert.equal(ok, true);
    const out = JSON.parse(logs.join("\n"));
    assert.equal(out.profile.name, "acme");
    assert.equal(out.profile.workflows[0].name, "release");
    assert.deepEqual(out.profile.scope.egress, ["api.acme.com"]);
  });

  it("check is clean after freeze (round-trip)", async () => {
    mkdirSync(join(dir, ".claude/skills/s1"), { recursive: true });
    writeFileSync(join(dir, ".claude/skills/s1/SKILL.md"), "# s1\n");
    setArgs("freeze");
    await cmdProfile();

    setArgs("check", "--json");
    logs = [];
    const ok = await cmdProfile();
    assert.equal(ok, true);
    const out = JSON.parse(logs.join("\n"));
    assert.equal(out.clean, true);
    assert.equal(out.driftCount, 0);
  });

  it("check --gate exits non-zero on drift", async () => {
    // Declare a skill that isn't present → removed drift.
    writeFileSync(join(dir, PROFILE_FILE), `version = 1\n[[skills]]\nname = "ghost"\n`);
    setArgs("check", "--json", "--gate");
    const ok = await cmdProfile();
    assert.equal(ok, false); // gating: drift → non-zero
    const out = JSON.parse(logs.join("\n"));
    assert.equal(out.clean, false);
    assert.equal(out.gate, true);
  });

  it("check without --gate reports drift but still exits 0 (warn)", async () => {
    writeFileSync(join(dir, PROFILE_FILE), `version = 1\n[[skills]]\nname = "ghost"\n`);
    setArgs("check", "--json");
    const ok = await cmdProfile();
    assert.equal(ok, true); // warn: drift but exit 0
    const out = JSON.parse(logs.join("\n"));
    assert.equal(out.clean, false);
  });

  it("rejects an unknown subcommand", async () => {
    setArgs("bogus");
    const ok = await cmdProfile();
    assert.equal(ok, false);
    assert.match(logs.join("\n"), /usage: kit profile/);
  });
});
