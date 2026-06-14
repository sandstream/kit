import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseSnykJson,
  recordSnykFindings,
  fetchSnykIssues,
} from "./scan.js";

const SINGLE_PROJECT = JSON.stringify({
  ok: false,
  projectName: "my-app",
  vulnerabilities: [
    {
      id: "SNYK-JS-LODASH-1234",
      title: "Prototype Pollution",
      severity: "high",
      packageName: "lodash",
      version: "4.17.15",
      fixedIn: ["4.17.21"],
      cvssScore: 7.3,
      identifiers: { CWE: ["CWE-1321"] },
    },
  ],
});

const MULTI_PROJECT = JSON.stringify([
  { ok: true, projectName: "service-a", vulnerabilities: [] },
  {
    ok: false,
    projectName: "service-b",
    vulnerabilities: [
      { id: "SNYK-PY-DJANGO-9999", title: "SQLi", severity: "critical" },
    ],
  },
]);

describe("parseSnykJson", () => {
  it("handles single-project output", () => {
    const results = parseSnykJson(SINGLE_PROJECT);
    assert.equal(results.length, 1);
    assert.equal(results[0]!.vulnerabilities.length, 1);
    assert.equal(results[0]!.vulnerabilities[0]!.severity, "high");
    assert.equal(results[0]!.vulnerabilities[0]!.packageName, "lodash");
  });

  it("handles --all-projects multi-project output", () => {
    const results = parseSnykJson(MULTI_PROJECT);
    assert.equal(results.length, 2);
    assert.equal(results[0]!.ok, true);
    assert.equal(results[1]!.vulnerabilities[0]!.severity, "critical");
  });

  it("throws structured error on invalid JSON", () => {
    assert.throws(() => parseSnykJson("{not-json"), /Invalid Snyk JSON/);
  });

  it("tolerates empty / malformed result objects", () => {
    const empty = parseSnykJson("{}");
    assert.equal(empty[0]!.vulnerabilities.length, 0);
    assert.equal(empty[0]!.ok, false);
  });
});

describe("recordSnykFindings", () => {
  it("appends one JSONL line per vulnerability", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-snyk-"));
    try {
      const results = parseSnykJson(SINGLE_PROJECT);
      const { written } = await recordSnykFindings(results, dir);
      assert.equal(written, 1);
      const text = readFileSync(join(dir, ".kit-scan-results.jsonl"), "utf-8");
      const line = JSON.parse(text.trim());
      assert.equal(line.source, "snyk");
      assert.equal(line.severity, "high");
      assert.equal(line.package, "lodash");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes nothing when there are no vulnerabilities", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-snyk-"));
    try {
      const { written } = await recordSnykFindings([{ ok: true, vulnerabilities: [] }], dir);
      assert.equal(written, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("fetchSnykIssues", () => {
  it("refuses when SNYK_TOKEN missing", async () => {
    const prev = process.env.SNYK_TOKEN;
    delete process.env.SNYK_TOKEN;
    try {
      await assert.rejects(
        () => fetchSnykIssues({ orgSlug: "demo" }),
        /SNYK_TOKEN not set/,
      );
    } finally {
      if (prev !== undefined) process.env.SNYK_TOKEN = prev;
    }
  });

  it("throws on unreachable API", async () => {
    await assert.rejects(() =>
      fetchSnykIssues({
        token: "test",
        orgSlug: "demo",
        apiBase: "https://127.0.0.1:1",
      }),
    );
  });
});
