import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { summarizeCheckRun, fullCheckPayload } from "./check-mcp-summary.js";
import type { CheckRunResult } from "./check-run.js";

/** A run with one of everything: a pass, a fail, a warn, an honest skip, and lost coverage. */
function runFixture(over: Partial<CheckRunResult> = {}): CheckRunResult {
  return {
    ok: false,
    verdict: {
      ok: false,
      dimensions: [
        { name: "tools", ok: true, detail: "1/1" },
        { name: "security", ok: false, detail: "1 real issue" },
      ],
      failed: ["security"],
    } as unknown as CheckRunResult["verdict"],
    tools: [{ name: "node", required: "22", installed: "22.1.0", ok: true }],
    services: [],
    secrets: { templateExists: true, keys: [] },
    skills: [],
    hooks: [],
    webSearch: null,
    deploy: [],
    security: [
      {
        category: "dependency",
        name: "npm audit",
        status: "fail",
        detail: "2 high severity",
        severity: "high",
      },
      { category: "secrets", name: "secrets scan", status: "warn", detail: "4 unverified" },
      {
        category: "supply-chain",
        name: "guarddog",
        status: "skip",
        detail: "opt-in — not enabled",
      },
      {
        category: "dependency",
        name: "trivy",
        status: "skip",
        detail: "binary absent",
        didNotRun: true,
      },
      { category: "exposure", name: ".env gitignored", status: "pass", detail: "all patterns" },
    ],
    tests: [{ name: "unit-test coverage", status: "pass", detail: "84 files" }] as never,
    locks: [],
    scope: null,
    ...over,
  } as CheckRunResult;
}

describe("summarizeCheckRun", () => {
  it("keeps the verdict and drops only passing rows", () => {
    const s = summarizeCheckRun(runFixture());
    assert.equal(s.ok, false);
    assert.deepEqual(s.failed, ["security"]);
    assert.equal(s.summarized, true);
    const names = s.findings.map((f) => f.name);
    assert.deepEqual(names, ["npm audit", "secrets scan", "guarddog", "trivy"]);
    assert.equal(s.passesOmitted, 3); // node, .env gitignored, unit-test coverage
  });

  it("never omits a skip — lost looking must not compress into not failing", () => {
    const s = summarizeCheckRun(runFixture());
    const guarddog = s.findings.find((f) => f.name === "guarddog");
    assert.ok(guarddog, "an honest skip has to survive summarization");
    assert.equal(guarddog.status, "skip");
  });

  it("never omits a didNotRun row, and carries the flag through", () => {
    const s = summarizeCheckRun(runFixture());
    const trivy = s.findings.find((f) => f.name === "trivy");
    assert.ok(trivy, "a check that could not run has to survive summarization");
    assert.equal(trivy.didNotRun, true);
    assert.equal(s.counts.didNotRun, 1);
  });

  it("counts every row, including the ones it left out", () => {
    const s = summarizeCheckRun(runFixture());
    assert.deepEqual(s.counts, { passed: 3, failed: 1, warnings: 1, skipped: 2, didNotRun: 1 });
  });

  it("keeps severity on a finding", () => {
    const s = summarizeCheckRun(runFixture());
    assert.equal(s.findings.find((f) => f.name === "npm audit")?.severity, "high");
  });

  it("carries scope, so a narrowed green cannot read as a full one", () => {
    const s = summarizeCheckRun(runFixture({ scope: ["security"], ok: true }));
    assert.deepEqual(s.scope, ["security"]);
  });

  it("says nothing about a detail file unless one was written", () => {
    assert.equal(summarizeCheckRun(runFixture()).detail, undefined);
    const withRef = summarizeCheckRun(runFixture(), { path: "/tmp/x.json", hint: "full run" });
    assert.equal(withRef.detail?.path, "/tmp/x.json");
  });

  it("is materially smaller than the full payload it replaces", () => {
    const run = runFixture();
    const summary = JSON.stringify(summarizeCheckRun(run)).length;
    const full = JSON.stringify(fullCheckPayload(run)).length;
    assert.ok(summary < full, `summary ${summary} should be smaller than full ${full}`);
  });

  it("an all-green run summarizes to the verdict and no findings", () => {
    const green = runFixture({
      ok: true,
      security: [
        { category: "exposure", name: ".env gitignored", status: "pass", detail: "ok" },
      ] as never,
      tests: [],
    });
    const s = summarizeCheckRun(green);
    assert.deepEqual(s.findings, []);
    assert.equal(s.ok, true);
    assert.equal(s.counts.failed, 0);
  });
});

describe("fullCheckPayload", () => {
  it("carries every dimension, so detail:true loses nothing", () => {
    const p = fullCheckPayload(runFixture());
    for (const key of [
      "ok",
      "scope",
      "dimensions",
      "failed",
      "tools",
      "services",
      "secrets",
      "skills",
      "hooks",
      "webSearch",
      "deploy",
      "security",
      "tests",
      "locks",
    ]) {
      assert.ok(key in p, `missing ${key}`);
    }
  });
});
