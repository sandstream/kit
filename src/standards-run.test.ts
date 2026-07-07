import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStandardsGate } from "./standards-run.js";

// A bare TS project with no linters installed: every gate is a setup gap, so the
// score is over gates that RAN (0), findings/failed are 0, and ok stays true — the
// P5 "setup gaps aren't failures" contract.
describe("standards-run — summary separates setup gaps from findings", () => {
  it("all-gap repo → ok, zero findings, gaps counted separately", async () => {
    const repo = mkdtempSync(join(tmpdir(), "kit-srun-"));
    const prevBaseline = process.env.KIT_BASELINE_FILE;
    try {
      writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "x", version: "1.0.0" }));
      writeFileSync(join(repo, "index.ts"), "export const x = 1;\n");
      const r = await runStandardsGate({ cwd: repo, category: "general" });
      // lizard/jscpd/scc absent here → 3 setup gaps, none ran.
      assert.equal(r.summary.setupGaps >= 1, true);
      assert.equal(r.summary.findings, 0);
      assert.equal(r.summary.failed, 0);
      assert.equal(r.ok, true, "setup gaps do not fail the gate by default");
    } finally {
      if (prevBaseline === undefined) delete process.env.KIT_BASELINE_FILE;
      else process.env.KIT_BASELINE_FILE = prevBaseline;
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("--enforce turns setup gaps into a failing gate", async () => {
    const repo = mkdtempSync(join(tmpdir(), "kit-srun2-"));
    try {
      writeFileSync(join(repo, "index.ts"), "export const x = 1;\n");
      const r = await runStandardsGate({ cwd: repo, category: "general", enforce: true });
      assert.equal(r.ok, false, "setup gaps fail closed under --enforce");
      assert.equal(r.summary.failed >= 1, true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("an unknown category still returns a well-formed envelope", async () => {
    const repo = mkdtempSync(join(tmpdir(), "kit-srun3-"));
    try {
      const r = await runStandardsGate({ cwd: repo, category: "nonsense" });
      // no dimension matches "nonsense" → no checks, trivially ok.
      assert.equal(r.ok, true);
      assert.equal(r.checks.length, 0);
      assert.equal(r.summary.score, "0/0");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
