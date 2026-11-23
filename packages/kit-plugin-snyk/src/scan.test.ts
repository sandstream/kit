import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseSnykJson,
  recordSnykFindings,
  fetchSnykIssues,
  IncompleteSnykIssuesError,
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
    vulnerabilities: [{ id: "SNYK-PY-DJANGO-9999", title: "SQLi", severity: "critical" }],
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

  it("rejects malformed empty reports and marks incomplete projects with readable peers", () => {
    for (const report of ["{}", "null", "[]"]) {
      assert.throws(() => parseSnykJson(report), /Incomplete Snyk report/);
    }
    const [valid, malformed] = parseSnykJson(`[${SINGLE_PROJECT},{}]`);
    assert.equal(valid?.vulnerabilities.length, 1);
    assert.equal(malformed?.coverage, "partial");
  });
});

describe("recordSnykFindings", () => {
  it("appends one JSONL line per vulnerability", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-snyk-"));
    try {
      const results = parseSnykJson(`[${SINGLE_PROJECT},{}]`);
      assert.deepEqual(await recordSnykFindings(results, dir), { written: 1, coverage: "partial" });
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
  const options = { token: "fixture", orgSlug: "org", apiBase: "https://api.example.test" };

  it("reads the next issue page and rejects an absent data array", async (t) => {
    let second: unknown = { data: [{ id: "second", attributes: { title: "Second" } }] };
    t.mock.method(globalThis, "fetch", async (url: URL) => {
      if (url.searchParams.has("starting_after")) return Response.json(second);
      return Response.json({
        data: [{ id: "first", attributes: { title: "First" } }],
        links: { next: "?starting_after=fixture&version=2024-10-15" },
      });
    });
    assert.deepEqual(
      (await fetchSnykIssues(options)).map((issue) => issue.id),
      ["first", "second"],
    );

    second = {};
    await assert.rejects(
      () => fetchSnykIssues(options),
      (error: unknown) => {
        assert.ok(error instanceof IncompleteSnykIssuesError);
        assert.deepEqual(
          error.findings.map((issue) => issue.id),
          ["first"],
        );
        return true;
      },
    );
  });

  it("refuses a pagination link to another origin before requesting it", async (t) => {
    const fetchMock = t.mock.method(globalThis, "fetch", async () =>
      Response.json({ data: [], links: { next: "https://other.example.test/page" } }),
    );
    await assert.rejects(
      () => fetchSnykIssues(options),
      /pagination link changes the issue endpoint/,
    );
    assert.equal(fetchMock.mock.callCount(), 1);
  });
});

describe("Snyk API errors", () => {
  for (const source of ["explicit", "env"]) {
    it(`masks a known ${source} token in an HTTP error`, async (t) => {
      const token = "snyk:v42";
      const priorToken = process.env.SNYK_TOKEN;
      process.env.SNYK_TOKEN = source === "env" ? token : "unused-env-token";
      t.after(() => {
        if (priorToken === undefined) delete process.env.SNYK_TOKEN;
        else process.env.SNYK_TOKEN = priorToken;
      });
      const fetchMock = t.mock.method(
        globalThis,
        "fetch",
        async (_url: string | URL | Request, init?: RequestInit) => {
          assert.equal(new Headers(init?.headers).get("authorization"), `token ${token}`);
          return new Response(`request_id=req_snyk rejected credential ${token}`, { status: 401 });
        },
      );
      await assert.rejects(
        () =>
          fetchSnykIssues({
            token: source === "explicit" ? token : undefined,
            orgSlug: "org",
            apiBase: "https://api.example.test",
          }),
        { message: "Snyk API 401: request_id=req_snyk rejected credential [REDACTED]" },
      );
      assert.equal(fetchMock.mock.callCount(), 1);
    });
  }

  it("keeps the no-body fallback when an error response cannot be read", async (t) => {
    t.mock.method(
      globalThis,
      "fetch",
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("unreadable response"));
            },
          }),
          { status: 403 },
        ),
    );
    await assert.rejects(
      () =>
        fetchSnykIssues({
          token: "fixture-token",
          orgSlug: "org",
          apiBase: "https://api.example.test",
        }),
      { message: "Snyk API 403: <no body>" },
    );
  });

  it("refuses when SNYK_TOKEN missing", async () => {
    const prev = process.env.SNYK_TOKEN;
    delete process.env.SNYK_TOKEN;
    try {
      await assert.rejects(() => fetchSnykIssues({ orgSlug: "demo" }), /SNYK_TOKEN not set/);
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
