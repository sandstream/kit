/**
 * MHB-03: the browser-evidence gate counted a contract case as satisfied whenever
 * Playwright reported `status: "expected"`. That field does not mean "passed", it means
 * "the outcome matched what the spec declared" — so a spec marked `test.fail()` reports
 * `status: "expected"` precisely BECAUSE it failed. A harness could therefore satisfy the
 * whole authz/money-flow gate with tests that never passed, which is the one thing this
 * evidence check exists to make impossible.
 *
 * A case now counts only when the run matched expectations, the expectation WAS "passed",
 * and at least one recorded result actually passed.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { MONKEY_ROLES } from "./monkey-test-contract.js";
import { validatePlaywrightEvidence } from "./monkey-test-evidence.js";

const PROJECTS = ["desktop-chromium", "mobile-chrome"] as const;
const RUN_ID = "run-1";

type TestShape = Record<string, unknown>;

/** A full contract-satisfying report whose every test carries `shape`. */
function report(shape: (projectName: string) => TestShape): unknown {
  const tests = (): TestShape[] => PROJECTS.map((projectName) => shape(projectName));
  const suites: unknown[] = MONKEY_ROLES.map((role) => ({
    title: `${role.id}: ${role.label}`,
    specs: [{ title: "route crawl", tests: tests() }],
  }));
  suites.push({ title: "customer payment", specs: [{ title: "money flow", tests: tests() }] });
  return {
    config: { metadata: { kitMonkeyContract: 1, kitMonkeyRunId: RUN_ID } },
    suites: [{ title: "monkey.spec.ts", suites }],
    errors: [],
  };
}

async function validate(doc: unknown): Promise<{ ok: boolean; detail: string }> {
  const root = await mkdtemp(join(tmpdir(), "kit-monkey-forgery-"));
  try {
    await mkdir(join(root, ".kit", "monkey-test"), { recursive: true });
    await writeFile(
      join(root, ".kit", "monkey-test", "playwright-report.json"),
      JSON.stringify(doc),
    );
    return await validatePlaywrightEvidence(root, RUN_ID);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("browser evidence cannot be forged with a failing-but-expected test (MHB-03)", () => {
  it("accepts a report whose contract cases actually passed", async () => {
    const r = await validate(
      report((projectName) => ({
        projectName,
        expectedStatus: "passed",
        status: "expected",
        results: [{ status: "passed" }],
      })),
    );
    assert.equal(r.ok, true, r.detail);
  });

  it("rejects a `test.fail()` report: expected, because it failed", async () => {
    const r = await validate(
      report((projectName) => ({
        projectName,
        expectedStatus: "failed",
        status: "expected",
        results: [{ status: "failed" }],
      })),
    );
    assert.equal(r.ok, false, "a test that passed only by failing is not evidence");
    assert.match(r.detail, /missing successful contract cases/);
  });
});

describe("browser evidence requires a result that actually passed (MHB-03)", () => {
  it("rejects a case with no passing result at all", async () => {
    const r = await validate(
      report((projectName) => ({
        projectName,
        expectedStatus: "passed",
        status: "expected",
        results: [{ status: "skipped" }],
      })),
    );
    assert.equal(r.ok, false);
    assert.match(r.detail, /missing successful contract cases/);
  });

  it("rejects a case that records no results", async () => {
    const r = await validate(
      report((projectName) => ({ projectName, expectedStatus: "passed", status: "expected" })),
    );
    assert.equal(r.ok, false);
  });

  it("still rejects an unexpected (genuinely failing) case", async () => {
    const r = await validate(
      report((projectName) => ({
        projectName,
        expectedStatus: "passed",
        status: "unexpected",
        results: [{ status: "failed" }],
      })),
    );
    assert.equal(r.ok, false);
  });

  it("names the money flow when only it is forged", async () => {
    const doc = report((projectName) => ({
      projectName,
      expectedStatus: "passed",
      status: "expected",
      results: [{ status: "passed" }],
    })) as {
      suites: { suites: { title?: string; specs: { tests: TestShape[] }[] }[] }[];
    };
    const money = doc.suites[0].suites.find((s) => s.title === "customer payment")!;
    money.specs[0].tests = PROJECTS.map((projectName) => ({
      projectName,
      expectedStatus: "failed",
      status: "expected",
      results: [{ status: "failed" }],
    }));

    const r = await validate(doc);

    assert.equal(r.ok, false);
    assert.match(r.detail, /money flow/);
    assert.doesNotMatch(r.detail, /route crawl/);
  });
});
