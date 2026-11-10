import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseSkillManifest, snapshotOf } from "./skill/test.js";

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "kit-runtime-cli-"));
  dirs.push(root);
  const skill = join(root, "skills", "x");
  mkdirSync(skill, { recursive: true });
  const source =
    '---\nname: x\ndescription: "Read the requested file and explain its contents."\nallowed-tools: Read\n---\n\nRead the requested file. Explain its contents. Do not change any files.\n';
  writeFileSync(join(skill, "SKILL.md"), source);
  writeFileSync(
    join(skill, ".kit-skill.snapshot.json"),
    JSON.stringify(snapshotOf(parseSkillManifest(source))),
  );
  return root;
}

function run(root: string, flags = ["--runtime", "--gate", "--json"]) {
  const moduleUrl = new URL("./commands/skill.js", import.meta.url).href;
  const loader = import.meta.url.endsWith(".ts") ? ["--import", import.meta.resolve("tsx")] : [];
  return spawnSync(
    process.execPath,
    [
      ...loader,
      "--input-type=module",
      "-e",
      `
    const { cmdSkill } = await import(${JSON.stringify(moduleUrl)});
    process.argv = [process.execPath, 'kit', 'skill', 'test', ${JSON.stringify(join(root, "skills", "x"))}, ...${JSON.stringify(flags)}];
    process.exitCode = await cmdSkill() ? 0 : 1;
  `,
    ],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 15_000,
      env: {
        ...process.env,
        HOME: root,
        KIT_MEMORY_DB: join(root, "memory.db"),
        KIT_MEMORY_DIR: join(root, "memory"),
        KIT_NON_INTERACTIVE: "1",
        KIT_AUDIT_ANCHOR: "0",
        KIT_NO_UPDATE_CHECK: "1",
        TSX_DISABLE_CACHE: "1",
        NO_COLOR: "1",
      },
    },
  );
}

function createSchema(db: DatabaseSync, modern: boolean): void {
  db.exec(`CREATE TABLE schema_meta (version INTEGER); INSERT INTO schema_meta VALUES (${modern ? 18 : 17});
    CREATE TABLE pending_actions (claim_owner TEXT);
    CREATE TABLE memory_projects (project_id TEXT);
    CREATE TABLE file_index (path TEXT${modern ? ", parser_version INTEGER DEFAULT 0" : ""});
    CREATE TABLE messages (uuid TEXT PRIMARY KEY, session_id TEXT${modern ? ", tool_capture_version INTEGER DEFAULT 0, tool_capture_count INTEGER" : ""});
    CREATE TABLE tool_uses (id INTEGER PRIMARY KEY, message_uuid TEXT, session_id TEXT, tool_name TEXT, tool_input TEXT, timestamp TEXT${modern ? ", call_id TEXT, outcome TEXT DEFAULT 'unknown', outcome_at TEXT" : ""});`);
}

function seed(
  root: string,
  opts: {
    legacy?: boolean;
    outcome?: string;
    capture?: number;
    tool?: string;
    skillOutcome?: string;
  } = {},
): void {
  const modern = !opts.legacy;
  const db = new DatabaseSync(join(root, "memory.db"));
  try {
    createSchema(db, modern);
    for (const [id, tool, input, outcome, ts] of [
      ["skill", "Skill", '{"skill":"x"}', opts.skillOutcome ?? "returned", "2026-11-05T10:00:00Z"],
      ["action", opts.tool ?? "Write", "{}", opts.outcome ?? "unknown", "2026-11-05T10:00:01Z"],
    ]) {
      db.prepare(`INSERT INTO messages VALUES (?, 's1'${modern ? ", ?, 1" : ""})`).run(
        ...[id, ...(modern ? [opts.capture ?? 1] : [])],
      );
      db.prepare(
        `INSERT INTO tool_uses (message_uuid, session_id, tool_name, tool_input, timestamp${modern ? ", outcome" : ""}) VALUES (?, 's1', ?, ?, ?${modern ? ", ?" : ""})`,
      ).run(...[id, tool, input, ts, ...(modern ? [outcome] : [])]);
    }
  } finally {
    db.close();
  }
}

describe("runtime command evidence gate", () => {
  it("refuses missing runtime evidence without creating a memory database", () => {
    const root = fixture();
    const result = run(root);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, false);
    assert.equal(report.hasSkips, true);
    assert.deepEqual(
      report.runtime.map((check: { status: string }) => check.status),
      ["skip", "skip"],
    );
    assert.equal(report.runtimeEvidence, null);
    assert.equal(existsSync(join(root, "memory.db")), false);
  });

  it("reads legacy17 in place and reports uncertain attribution without migration", () => {
    const root = fixture();
    seed(root, { legacy: true });
    const before = readFileSync(join(root, "memory.db"));
    const result = run(root);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.runtimeEvidence.runs, 0);
    assert.equal(report.runtimeEvidence.unresolvedInvocations, 1);
    assert.equal(report.runtimeEvidence.unattributedActions, 1);
    assert.equal(report.runtimeEvidence.violations, 0);
    assert.equal(report.runtimeEvidence.capture.complete, false);
    assert.deepEqual(
      report.runtime.map((check: { status: string }) => check.status),
      ["skip", "skip"],
    );
    assert.deepEqual(readFileSync(join(root, "memory.db")), before);
  });

  for (const outcome of ["unknown", "error", "conflict"]) {
    it(`refuses ${outcome} outside scope with visible counts and no inferred denial`, () => {
      const root = fixture();
      seed(root, { outcome });
      const result = run(root);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      const report = JSON.parse(result.stdout);
      assert.equal(report.runtimeEvidence.outcomes[outcome], 1);
      assert.equal(report.runtimeEvidence.inconclusiveForbidden, 1);
      assert.equal(report.runtimeEvidence.violations, 0);
      assert.equal(report.runtimeEvidence.deniedForbidden, 0);
      assert.deepEqual(
        report.runtime.map((check: { status: string }) => check.status),
        ["skip", "skip"],
      );
      assert.equal(report.ok, false);
    });
  }
});

describe("runtime command outcomes", () => {
  it("passes only with complete capture and a proven forbidden denial", () => {
    const root = fixture();
    seed(root, { outcome: "denied" });
    const result = run(root);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.hasSkips, false);
    assert.deepEqual(
      report.runtime.map((check: { status: string }) => check.status),
      ["pass", "pass"],
    );
    assert.equal(report.runtimeEvidence.deniedForbidden, 1);
    assert.equal(report.runtimeEvidence.capture.complete, true);
  });

  it("refuses incomplete capture even when every recorded forbidden request was denied", () => {
    const root = fixture();
    seed(root, { outcome: "denied", capture: 0 });
    const result = run(root);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, false);
    assert.deepEqual(report.runtimeEvidence.capture, { complete: false, incompleteMessages: 2 });
    assert.deepEqual(
      report.runtime.map((check: { status: string }) => check.status),
      ["skip", "skip"],
    );
  });

  it("fails a recorded returned result outside scope without claiming successful execution", () => {
    const root = fixture();
    seed(root, { outcome: "returned" });
    const result = run(root);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.runtimeEvidence.violations, 1);
    assert.deepEqual(
      report.runtime.map((check: { status: string }) => check.status),
      ["fail", "fail"],
    );
    for (const check of report.runtime) {
      assert.match(check.detail, /recorded returned result/);
      assert.match(check.detail, /[Ee]ffects are unverified/);
      assert.doesNotMatch(check.detail, /succeeded|executed|action\(s\) ran|control absent/);
    }
  });

  it("requires negative controls to be exercised for the runtime gate", () => {
    const root = fixture();
    seed(root, { outcome: "returned", tool: "Read" });
    const result = run(root);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(
      report.runtime.map((check: { status: string }) => check.status),
      ["pass", "skip"],
    );
    assert.match(report.runtime[1].detail, /not exercised/);
  });

  it("keeps advisory exit zero while both JSON and human output disclose incomplete evidence", () => {
    const root = fixture();
    seed(root);
    const advisory = run(root, ["--runtime", "--json"]);
    assert.equal(advisory.status, 0, advisory.stderr);
    assert.equal(JSON.parse(advisory.stdout).ok, false);
    const human = run(root, ["--runtime", "--gate"]);
    assert.equal(human.status, 1, human.stderr);
    assert.match(human.stdout, /module discipline: incomplete/);
    assert.match(human.stdout, /1 unknown/);
    assert.doesNotMatch(human.stdout, /module discipline: ok/);
  });
});

describe("runtime command mode boundaries", () => {
  it("leaves static-only gate behavior independent of runtime evidence", () => {
    const root = fixture();
    const result = run(root, ["--gate", "--json"]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.runtime, undefined);
    assert.equal(existsSync(join(root, "memory.db")), false);
  });

  for (const skillOutcome of ["returned", "denied", "unknown"]) {
    it(`attributes structured audit denials only to a returned Skill span (${skillOutcome})`, () => {
      const root = fixture();
      seed(root, { skillOutcome, outcome: "returned", tool: "Read" });
      writeFileSync(
        join(root, ".kit-audit.jsonl"),
        JSON.stringify({
          operation: "gate-fs",
          success: false,
          timestamp: "2026-11-05T10:00:02Z",
          metadata: { phase: "pretooluse-deny", session_id: "s1" },
        }) + "\n",
      );
      const result = run(root);
      assert.equal(
        result.status,
        skillOutcome === "returned" ? 0 : 1,
        result.stdout + result.stderr,
      );
      const report = JSON.parse(result.stdout);
      assert.equal(report.runtimeEvidence.deniedForbidden, skillOutcome === "returned" ? 1 : 0);
      assert.equal(report.ok, skillOutcome === "returned");
    });
  }
});
