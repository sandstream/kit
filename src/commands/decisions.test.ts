/**
 * `kit decisions`, driven end to end through the real CLI.
 *
 * The command exists because of what the check demands: `kit check` can fail a run that recorded
 * no decisions, so there must be a way to record one. A gate whose artifact has no producer is a
 * dead end, and the producer has to refuse the same things the verifier refuses — otherwise `add`
 * writes lines that `verify` rejects, and the operator learns the schema by argument.
 *
 * Everything runs in a temporary cwd, so no test can write into the repo's own ledger.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CLI_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
const LEDGER = ".kit/decisions.jsonl";

function run(
  cwd: string,
  args: string[],
  env: Record<string, string> = {},
): { exitCode: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd,
    encoding: "utf-8",
    env: {
      ...process.env,
      KIT_HIDE_HOOK_SKIP_BANNER: "1",
      KIT_AUDIT_ANCHOR: "0",
      KIT_NON_INTERACTIVE: "1",
      ...env,
    },
    timeout: 120_000,
  });
  return { exitCode: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const ADD = [
  "decisions",
  "add",
  "--decision",
  "kept the ledger out of the audit log",
  "--confidence",
  "0.6",
  "--assumed",
  "a per-run artifact does not need the chain",
  "--would-have-asked",
  "should a ledger survive across runs?",
];

function sandbox(): string {
  return mkdtempSync(join(tmpdir(), "kit-decisions-"));
}

describe("kit decisions add", () => {
  it("writes one entry the verifier accepts", () => {
    const dir = sandbox();
    try {
      const added = run(dir, ADD);
      assert.equal(added.exitCode, 0, added.stderr);
      const lines = readFileSync(join(dir, LEDGER), "utf-8").trim().split("\n");
      assert.equal(lines.length, 1);
      const entry = JSON.parse(lines[0]);
      assert.equal(entry.confidence, 0.6);
      assert.equal(entry.reviewed, false);
      assert.ok(entry.id, "an entry needs an id a review can refer to");

      const verified = run(dir, ["decisions", "verify"]);
      assert.equal(verified.exitCode, 0, verified.stdout + verified.stderr);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a missing fact by name, and writes nothing", () => {
    const dir = sandbox();
    try {
      const without = ADD.filter((a, i) => a !== "--assumed" && ADD[i - 1] !== "--assumed");
      const r = run(dir, without);
      assert.notEqual(r.exitCode, 0);
      assert.match(r.stdout + r.stderr, /--assumed/);
      assert.equal(existsSync(join(dir, LEDGER)), false, "a refused add must not leave a line");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a confidence outside 0..1 rather than recording an entry verify would reject", () => {
    const dir = sandbox();
    try {
      const r = run(
        dir,
        ADD.map((a) => (a === "0.6" ? "60" : a)),
      );
      assert.notEqual(r.exitCode, 0);
      assert.match(r.stdout + r.stderr, /confidence/);
      assert.equal(existsSync(join(dir, LEDGER)), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("appends rather than replacing", () => {
    const dir = sandbox();
    try {
      run(dir, ADD);
      run(
        dir,
        ADD.map((a) => (a === "0.6" ? "0.9" : a)),
      );
      const lines = readFileSync(join(dir, LEDGER), "utf-8").trim().split("\n");
      assert.equal(lines.length, 2);
      const ids = lines.map((l) => JSON.parse(l).id);
      assert.notEqual(ids[0], ids[1], "two decisions must be distinguishable");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is refused under read-only mode, like every other declared write", () => {
    const dir = sandbox();
    try {
      const r = run(dir, ADD, { KIT_READ_ONLY: "1" });
      assert.notEqual(r.exitCode, 0);
      assert.equal(existsSync(join(dir, LEDGER)), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("kit decisions list", () => {
  it("emits the entries as JSON", () => {
    const dir = sandbox();
    try {
      run(dir, ADD);
      const r = run(dir, ["decisions", "list", "--json"]);
      assert.equal(r.exitCode, 0, r.stderr);
      const parsed = JSON.parse(r.stdout);
      assert.equal(parsed.entries.length, 1);
      assert.equal(parsed.entries[0].confidence, 0.6);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("says the ledger is empty instead of failing", () => {
    const dir = sandbox();
    try {
      const r = run(dir, ["decisions", "list"]);
      assert.equal(r.exitCode, 0, r.stderr);
      assert.match(r.stdout, /no decisions/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("kit decisions verify", () => {
  it("passes when nothing required a ledger and none exists", () => {
    const dir = sandbox();
    try {
      const r = run(dir, ["decisions", "verify"]);
      assert.equal(r.exitCode, 0, r.stdout + r.stderr);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails when [decisions] require = true and the run recorded nothing", () => {
    const dir = sandbox();
    try {
      writeFileSync(join(dir, ".kit.toml"), "[decisions]\nrequire = true\n");
      const r = run(dir, ["decisions", "verify"]);
      assert.notEqual(r.exitCode, 0);
      assert.match(r.stdout + r.stderr, /decisions\.jsonl/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("names the unreadable line rather than reporting a clean ledger", () => {
    const dir = sandbox();
    try {
      mkdirSync(join(dir, ".kit"), { recursive: true });
      writeFileSync(join(dir, LEDGER), '{"id":"a"}\n');
      const r = run(dir, ["decisions", "verify"]);
      assert.notEqual(r.exitCode, 0);
      assert.match(r.stdout + r.stderr, /line 1/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("kit decisions — surface", () => {
  it("rejects an unknown subcommand with the usage line", () => {
    const dir = sandbox();
    try {
      const r = run(dir, ["decisions", "promote"]);
      assert.notEqual(r.exitCode, 0);
      assert.match(r.stdout + r.stderr, /add \| list \| verify/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects an unknown flag rather than ignoring it", () => {
    const dir = sandbox();
    try {
      const r = run(dir, [...ADD, "--reviewed"]);
      assert.notEqual(r.exitCode, 0);
      assert.match(r.stdout + r.stderr, /--reviewed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
