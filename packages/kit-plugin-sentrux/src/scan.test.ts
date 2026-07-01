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
    assert.equal(parseSentruxJson(JSON.stringify({ issues: [{ message: "x" }] })).gatePassed, false);
  });

  it("throws on invalid JSON; tolerates a non-object payload", () => {
    assert.throws(() => parseSentruxJson("not json"), /Invalid Sentrux JSON/);
    assert.deepEqual(parseSentruxJson("42"), { gatePassed: true, metrics: {}, violations: [] });
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
