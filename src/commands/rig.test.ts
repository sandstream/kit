import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { rmTemp } from "../temp-cleanup.test-support.js";

const adjacentCli = resolve(import.meta.dirname, "../cli.js");
const CLI = existsSync(adjacentCli)
  ? adjacentCli
  : resolve(import.meta.dirname, "../../dist/cli.js");

const MANIFEST = `
[input]
repo = "acme/webapp"
commit = "${"d".repeat(40)}"
prompt = "prompt.md"

[[defect]]
id = "d1"
file = "src/auth.ts"
line_start = 10
line_end = 12
kind = "missing-check"
split = "tune"
patch = "d1.diff"

[[defect]]
id = "h1"
file = "src/db.ts"
line_start = 5
line_end = 5
kind = "sql-injection"
split = "holdout"
patch = "h1.diff"

[[control]]
id = "c1"
patch = "c1.diff"
`;

/** Rows for one config: three runs over d1, h1 and c1. `hit[i]` decides whether run i catches. */
function rows(config: string, hit: boolean[], noisy: boolean[]): string {
  const base = { config, model: "m", model_version: "1", date: "2026-10-31" };
  const out: unknown[] = [];
  hit.forEach((h, i) => {
    const run = `r${i + 1}`;
    out.push(
      h
        ? {
            ...base,
            run,
            target: "d1",
            file: "src/auth.ts",
            line: 11,
            claim: "x",
            severity: "high",
          }
        : { ...base, run, target: "d1", none: true },
      h
        ? { ...base, run, target: "h1", file: "src/db.ts", line: 5, claim: "y", severity: "high" }
        : { ...base, run, target: "h1", none: true },
      noisy[i]
        ? { ...base, run, target: "c1", file: "src/x.ts", line: 1, claim: "z", severity: "low" }
        : { ...base, run, target: "c1", none: true },
    );
  });
  return out.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-rig-cli-"));
  writeFileSync(join(dir, "rig.toml"), MANIFEST);
  for (const f of ["prompt.md", "d1.diff", "h1.diff", "c1.diff"])
    writeFileSync(join(dir, f), `${f}\n`);
  writeFileSync(join(dir, "a.jsonl"), rows("A", [true, true, true], [false, false, true]));
  writeFileSync(join(dir, "b.jsonl"), rows("B", [false, false, false], [false, false, false]));
  return dir;
}

function kit(dir: string, args: string[], extraEnv: Record<string, string> = {}) {
  return spawnSync(process.execPath, [CLI, "rig", ...args], {
    cwd: dir,
    env: {
      ...process.env,
      HOME: dir,
      USERPROFILE: dir,
      KIT_IDENTITY_DIR: join(dir, ".id"),
      KIT_MEMORY_DIR: join(dir, ".mem"),
      KIT_AUDIT_ANCHOR_DIR: join(dir, ".anchor"),
      NODE_NO_WARNINGS: "1",
      ...extraEnv,
    },
    encoding: "utf8",
  });
}

/** Plan, ingest both configs, adjudicate. Returns the input id and the parsed result. */
function pipeline(dir: string) {
  const plan = JSON.parse(kit(dir, ["plan", "--json"]).stdout) as { inputId: string };
  assert.equal(kit(dir, ["ingest", "a.jsonl"]).status, 0);
  const again = JSON.parse(kit(dir, ["ingest", "a.jsonl", "--json"]).stdout) as {
    added: boolean;
  };
  assert.equal(again.added, false);
  assert.equal(kit(dir, ["ingest", "b.jsonl", "--strict"]).status, 0);
  const adj = kit(dir, ["adjudicate", "--json"]);
  assert.equal(adj.status, 0, adj.stderr);
  return {
    inputId: plan.inputId,
    result: JSON.parse(adj.stdout) as {
      inputId: string;
      stats: {
        config: string;
        tune: { recall: { mean: number } };
        controls: { falsePositiveRate: { mean: number } };
      }[];
      receipt: { findings: string[] };
    },
  };
}

describe("kit rig pipeline", () => {
  it("plans, ingests and adjudicates per config, storing the result under the input id", () => {
    const dir = fixture();
    try {
      const { inputId, result } = pipeline(dir);
      assert.match(inputId, /^[0-9a-f]{64}$/);
      assert.equal(result.inputId, inputId);
      assert.equal(result.receipt.findings.length, 2);
      assert.deepEqual(
        result.stats.map((s) => [s.config, s.tune.recall.mean]),
        [
          ["A", 1],
          ["B", 0],
        ],
      );
      assert.equal(result.stats[0].controls.falsePositiveRate.mean, 1 / 3);
      assert.ok(existsSync(join(dir, ".kit", "rig", inputId, "result.json")));
    } finally {
      rmTemp(dir);
    }
  });

  it("reports comparisons with the three limits and writes an audit event for the input", () => {
    const dir = fixture();
    try {
      const { inputId } = pipeline(dir);
      const report = kit(dir, ["report"]);
      assert.equal(report.status, 0, report.stderr);
      assert.match(report.stdout, /A vs B \(tune\): outside spread/);
      assert.match(report.stdout, /1\. Lower bound only/);
      assert.match(report.stdout, /2\. Goodhart/);
      assert.match(report.stdout, /3\. Transfer is unproven/);
      const audit = readFileSync(join(dir, ".kit-audit.jsonl"), "utf8");
      assert.match(audit, /"operation":"rig\.adjudicate"/);
      assert.ok(audit.includes(inputId));
    } finally {
      rmTemp(dir);
    }
  });
});

describe("kit rig refusals", () => {
  it("treats a changed prompt as a new input and refuses to report the old one's numbers", () => {
    const dir = fixture();
    try {
      kit(dir, ["ingest", "a.jsonl"]);
      writeFileSync(join(dir, "prompt.md"), "a different prompt\n");
      const adj = kit(dir, ["adjudicate"]);
      assert.notEqual(adj.status, 0);
      assert.match(adj.stderr, /no findings ingested for input/);
    } finally {
      rmTemp(dir);
    }
  });

  it("refuses a malformed file under --strict and an unknown target under --strict", () => {
    const dir = fixture();
    try {
      writeFileSync(join(dir, "bad.jsonl"), '{"run":"r1"}\n');
      const bad = kit(dir, ["ingest", "bad.jsonl", "--strict"]);
      assert.notEqual(bad.status, 0);
      assert.match(bad.stderr, /refused, 1 malformed row/);
      const unknown = {
        run: "r1",
        config: "A",
        target: "zz",
        none: true,
        model: "m",
        model_version: "1",
        date: "2026-10-31",
      };
      writeFileSync(join(dir, "unknown.jsonl"), `${JSON.stringify(unknown)}\n`);
      const u = kit(dir, ["ingest", "unknown.jsonl", "--strict"]);
      assert.notEqual(u.status, 0);
      assert.match(u.stderr, /target\(s\) not in the manifest: zz/);
    } finally {
      rmTemp(dir);
    }
  });

  it("is refused in read-only mode for ingest and adjudicate, but plan still runs", () => {
    const dir = fixture();
    try {
      const ro = kit(dir, ["ingest", "a.jsonl"], { KIT_READ_ONLY: "1" });
      assert.notEqual(ro.status, 0);
      assert.match(ro.stdout + ro.stderr, /read-only/);
      assert.equal(existsSync(join(dir, ".kit", "rig")), false);
      assert.equal(kit(dir, ["plan"], { KIT_READ_ONLY: "1" }).status, 0);
    } finally {
      rmTemp(dir);
    }
  });

  it("prints usage for a missing or unknown subcommand", () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-rig-usage-"));
    try {
      mkdirSync(join(dir, "x"));
      const none = kit(dir, []);
      assert.notEqual(none.status, 0);
      assert.match(none.stderr, /Usage: kit rig/);
      const unknown = kit(dir, ["bogus"]);
      assert.match(unknown.stderr, /unknown subcommand: bogus/);
      assert.match(
        execFileSync(process.execPath, [CLI, "help"], {
          encoding: "utf8",
          env: { ...process.env, NODE_NO_WARNINGS: "1" },
        }),
        /\brig\b/,
      );
    } finally {
      rmTemp(dir);
    }
  });
});
