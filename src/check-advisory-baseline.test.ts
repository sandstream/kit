/**
 * The verdict rules, separated from the mechanics so they can be tested without a package manager.
 *
 * Four states, and three of them are the interesting ones:
 *
 *   - **no baseline** → skip with the command to adopt one. Opt-in by construction: without a
 *     committed baseline there is no "new" to compare against, and warning about a choice nobody
 *     has made yet is noise.
 *   - **new advisory** → fail at the worst severity among the new ones, with remaining debt named
 *     so the size is visible without opening the file.
 *   - **stale entry** → fail as well. This is the rule that keeps the file honest: without it the
 *     baseline only grows, and a gate whose baseline nobody prunes stops meaning anything.
 *   - **audit could not run** → fail with `didNotRun`, never "no advisories found". An audit that
 *     did not happen is not a clean audit, which is the false green this whole area keeps producing.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkAdvisoryBaseline } from "./check-advisory-baseline.js";
import { ADVISORY_BASELINE_FILE, renderBaseline, type Advisory } from "./advisory-baseline.js";

function repo(opts: { baseline?: Advisory[]; lockfile?: string } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-adv-check-"));
  if (opts.baseline) {
    mkdirSync(join(dir, ".kit"), { recursive: true });
    writeFileSync(join(dir, ADVISORY_BASELINE_FILE), renderBaseline(opts.baseline));
  }
  if (opts.lockfile) writeFileSync(join(dir, opts.lockfile), "");
  return dir;
}

const adv = (id: string, severity: Advisory["severity"]): Advisory => ({
  id,
  package: "p",
  severity,
  title: "t",
});

describe("checkAdvisoryBaseline", () => {
  it("skips, naming the command that adopts it, when no baseline is committed", async () => {
    const dir = repo({ lockfile: "package-lock.json" });
    try {
      const r = await checkAdvisoryBaseline(dir);
      assert.equal(r.status, "skip");
      assert.match(r.detail, /kit security advisories --accept/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips with a reason when there is no lockfile to audit against", async () => {
    const dir = repo({ baseline: [adv("GHSA-2222-3333-4444", "high")] });
    try {
      const r = await checkAdvisoryBaseline(dir);
      assert.equal(r.status, "skip");
      assert.match(r.detail, /no lockfile/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips under an air-gap posture rather than pretending the registry answered", async () => {
    const dir = repo({
      baseline: [adv("GHSA-2222-3333-4444", "high")],
      lockfile: "package-lock.json",
    });
    const prev = process.env.KIT_AIRGAP;
    process.env.KIT_AIRGAP = "1";
    try {
      const r = await checkAdvisoryBaseline(dir);
      assert.equal(r.status, "skip");
      assert.match(r.detail, /air-gap/);
    } finally {
      if (prev === undefined) delete process.env.KIT_AIRGAP;
      else process.env.KIT_AIRGAP = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails with didNotRun when the audit itself could not produce a result", async () => {
    // A lockfile for a manager that is not installed here: the command cannot run, and the result
    // must not read as "no advisories".
    const dir = repo({
      baseline: [adv("GHSA-2222-3333-4444", "high")],
      lockfile: "pnpm-lock.yaml",
    });
    const prev = process.env.PATH;
    process.env.PATH = "/nonexistent";
    try {
      const r = await checkAdvisoryBaseline(dir);
      assert.equal(r.status, "fail");
      assert.equal(r.didNotRun, true, "an audit that did not happen is not a clean audit");
    } finally {
      process.env.PATH = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
