import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSentruxJson, recordSentruxFindings } from "./scan.js";

const GATE_FAIL = JSON.stringify({
  score: 7200,
  gate: { passed: false },
  metrics: { modularity: 0.8, acyclicity: 0.6, depth: 0.7, equality: 0.9, redundancy: 0.5 },
  violations: [
    { rule: "no-cycles", severity: "high", message: "cycle: a → b → a", file: "src/a.ts" },
    { id: "max-depth", level: "error", description: "module too deep", path: "src/deep.ts" },
  ],
});

const CLEAN = JSON.stringify({
  architecture_score: 9800,
  passed: true,
  metrics: {},
  violations: [],
});

describe("sentrux plugin", () => {
  it("parses gate-fail with violations (tolerant of field-name variants)", () => {
    const r = parseSentruxJson(GATE_FAIL);
    assert.equal(r.score, 7200);
    assert.equal(r.gatePassed, false);
    assert.equal(r.violations.length, 2);
    assert.equal(r.violations[0]?.rule, "no-cycles");
    assert.equal(r.violations[0]?.severity, "high");
    assert.equal(r.violations[1]?.rule, "max-depth"); // id fallback
    assert.equal(r.violations[1]?.severity, "high"); // level "error" → high
    assert.equal(r.violations[1]?.file, "src/deep.ts"); // path fallback
    assert.equal(r.metrics.modularity, 0.8);
  });

  it("parses a clean pass (architecture_score + passed aliases)", () => {
    const r = parseSentruxJson(CLEAN);
    assert.equal(r.score, 9800);
    assert.equal(r.gatePassed, true);
    assert.equal(r.violations.length, 0);
  });

  it("infers gatePassed from violations when no explicit flag", () => {
    assert.equal(parseSentruxJson(JSON.stringify({ violations: [] })).gatePassed, true);
    assert.equal(
      parseSentruxJson(JSON.stringify({ issues: [{ message: "x" }] })).gatePassed,
      false,
    );
  });

  it("rejects malformed reports without classifying them as clean", () => {
    assert.throws(() => parseSentruxJson("not json"), /Invalid Sentrux JSON/);
    for (const report of ["42", "{}", '{"passed":true,"violations":[{}]}']) {
      assert.throws(() => parseSentruxJson(report), /Invalid Sentrux report/);
    }
  });
});

describe("native Sentrux rule reports", () => {
  it("distinguishes an empty native rule run from a run that checked no rules", () => {
    const report = { pass: true, rules_checked: 1, violation_count: 0, violations: [] };
    assert.equal(parseSentruxJson(JSON.stringify(report)).gatePassed, true);
    assert.throws(
      () => parseSentruxJson(JSON.stringify({ pass: true, violations: [] })),
      /Invalid Sentrux report/,
    );
    for (const change of [
      { rules_checked: 0 },
      { rules_checked: "1" },
      { violation_count: 1 },
      { violation_count: undefined },
      { pass: undefined },
      { truncated: { rules_checked: 1, total_rules_defined: 3 } },
    ]) {
      assert.throws(
        () => parseSentruxJson(JSON.stringify({ ...report, ...change })),
        /Invalid Sentrux report/,
      );
    }
  });

  it("retains native findings and flags inconsistent counts as partial", () => {
    const violation = {
      rule: "boundary",
      severity: "Error",
      message: "Synthetic layer separation",
      files: ["src/app/demo.js", "src/core/internal/message.js"],
    };
    const report = { pass: false, rules_checked: 2, violation_count: 1, violations: [violation] };
    const parsed = parseSentruxJson(JSON.stringify(report));
    assert.equal(parsed.gatePassed, false);
    assert.equal(parsed.coverage, undefined);
    assert.equal(parsed.violations[0]?.file, "src/app/demo.js");
    assert.deepEqual(parsed.violations[0]?.files, violation.files);
    const contradictory = parseSentruxJson(JSON.stringify({ ...report, pass: true }));
    assert.equal(contradictory.gatePassed, false);
    assert.equal(contradictory.coverage, "partial");
    assert.deepEqual(contradictory.violations, parsed.violations);
    const partial = parseSentruxJson(
      JSON.stringify({
        ...report,
        pass: true,
        violation_count: 2,
      }),
    );
    assert.equal(partial.gatePassed, false);
    assert.equal(partial.coverage, "partial");
    assert.deepEqual(partial.violations, parsed.violations);
  });

  it("keeps warning-only passes and retains findings with invalid peer metadata", () => {
    const warning = { rule: "layers", message: "Review layer", severity: "Warning" };
    const report = { pass: true, rules_checked: 1, violation_count: 1, violations: [warning] };
    assert.equal(parseSentruxJson(JSON.stringify(report)).gatePassed, true);
    const result = parseSentruxJson(
      JSON.stringify({
        ...report,
        violation_count: 2,
        violations: [
          warning,
          { rule: "boundary", severity: { toString: null }, files: [null, "src/core.js"] },
        ],
      }),
    );
    assert.equal(result.coverage, "partial");
    assert.equal(result.gatePassed, false);
    assert.deepEqual(
      result.violations.map(({ rule }) => rule),
      ["layers", "boundary"],
    );
    assert.deepEqual(result.violations[1]?.files, ["src/core.js"]);
  });
});

it("includes native coverage in the finding record and recording receipt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kit-sentrux-"));
  try {
    const files = ["src/a.ts", "src/b.ts"];
    const result = parseSentruxJson(
      JSON.stringify({
        pass: false,
        rules_checked: 3,
        violation_count: 1,
        truncated: { rules_checked: 3, total_rules_defined: 4 },
        violations: [{ rule: "boundary", files }],
      }),
    );
    const ruleCoverage = { checkedRules: 3, reportedViolations: 1, definedRules: 4 };
    assert.equal(result.gatePassed, false);
    assert.deepEqual(await recordSentruxFindings(result, dir), {
      written: 1,
      coverage: "partial",
      ruleCoverage,
    });
    const row = JSON.parse(readFileSync(join(dir, ".kit-scan-results.jsonl"), "utf8"));
    assert.deepEqual(row.ruleCoverage, ruleCoverage);
    assert.deepEqual(row.files, files);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
describe("Sentrux finding output", () => {
  it("records valid violations from a partial report and returns its coverage", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-sentrux-"));
    try {
      const raw = JSON.parse(GATE_FAIL);
      const parsed = parseSentruxJson(
        JSON.stringify({ ...raw, violations: [null, raw.violations[0]] }),
      );
      assert.deepEqual(await recordSentruxFindings(parsed, dir), {
        written: 1,
        coverage: "partial",
      });
      const entry = JSON.parse(readFileSync(join(dir, ".kit-scan-results.jsonl"), "utf8"));
      assert.equal(entry.id, "no-cycles");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records one finding per violation to .kit-scan-results.jsonl", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sentrux-"));
    try {
      const res = await recordSentruxFindings(parseSentruxJson(GATE_FAIL), dir);
      assert.equal(res.written, 2);
      const lines = readFileSync(join(dir, ".kit-scan-results.jsonl"), "utf-8").trim().split("\n");
      assert.equal(lines.length, 2);
      const first = JSON.parse(lines[0]);
      assert.equal(first.source, "sentrux");
      assert.equal(first.id, "no-cycles");
      assert.equal(first.severity, "high");
      assert.equal(first.score, 7200);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("emits a synthetic finding when the gate fails with no discrete violations", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sentrux-"));
    try {
      const res = await recordSentruxFindings(
        parseSentruxJson(JSON.stringify({ score: 4000, passed: false, violations: [] })),
        dir,
      );
      assert.equal(res.written, 1);
      const line = JSON.parse(readFileSync(join(dir, ".kit-scan-results.jsonl"), "utf-8").trim());
      assert.equal(line.id, "sentrux-gate");
      assert.equal(line.severity, "high");
      assert.match(line.title, /score 4000/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes nothing when the gate passes clean", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sentrux-"));
    try {
      const res = await recordSentruxFindings(parseSentruxJson(CLEAN), dir);
      assert.equal(res.written, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
