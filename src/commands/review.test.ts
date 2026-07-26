import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectReview, type ReviewReport } from "./review.js";

// collectReview is the single core BOTH `kit review` (CLI renderer) and the MCP
// `kit_review` tool consume — these tests pin the report contract that keeps the
// two surfaces honest: stage order, per-stage summaries, and verdict aggregation.
describe("collectReview", () => {
  let tempDir: string;
  let originalCwd: string;
  let report: ReviewReport;

  before(async () => {
    // The underlying scanners (design/a11y, standards, security) walk
    // process.cwd() — chdir into an isolated fixture so the report is about
    // the fixture, not this repo, and the run stays fast.
    originalCwd = process.cwd();
    tempDir = await mkdtemp(join(tmpdir(), "kit-review-"));
    await writeFile(join(tempDir, ".gitignore"), ".env\n.env.local\n.env.*.local\n", "utf-8");
    await writeFile(join(tempDir, ".kit.toml"), "# empty kit config\n", "utf-8");
    process.chdir(tempDir);
    report = await collectReview({ cwd: tempDir });
  });

  after(async () => {
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns the four stages in the order the CLI always ran them", () => {
    assert.deepEqual(
      report.stages.map((s) => s.stage),
      ["check", "design", "standards", "adr"],
    );
  });

  it("every stage summary counts exactly its findings", () => {
    for (const s of report.stages) {
      const counts = { pass: 0, fail: 0, warn: 0, skip: 0 };
      for (const f of s.findings) counts[f.status]++;
      assert.deepEqual(s.summary, counts, `${s.stage} summary drifted from its findings`);
    }
  });

  it("ok aggregates the stage verdicts and failed names exactly the red stages", () => {
    assert.equal(
      report.ok,
      report.stages.every((s) => s.ok),
    );
    assert.deepEqual(
      report.failed,
      report.stages.filter((s) => !s.ok).map((s) => s.stage),
    );
  });

  it("adr stage is an explicit skip — never a silent pass — when the repo has no ADRs", () => {
    const adr = report.stages.find((s) => s.stage === "adr")!;
    assert.equal(adr.ok, true);
    assert.equal(adr.findings.length, 1);
    assert.equal(adr.findings[0].status, "skip");
    assert.match(adr.findings[0].detail, /no ADRs found/);
  });

  it("design stage skips (not fails) in a repo without component files", () => {
    const design = report.stages.find((s) => s.stage === "design")!;
    assert.equal(design.ok, true);
    assert.ok(design.findings.every((f) => f.status !== "fail"));
  });
});
