/**
 * MHB-02, end to end through the GENERATED spec.
 *
 * Two defects made the crawl's central authz assertion unable to fire:
 *
 *  1. `routeIsDenied` accepted the page's own text as proof of a denial. Any 200 whose body
 *     matched /forbidden|access denied|not authorized|sign in to continue/ was scored as
 *     denied, so a denied route the server actually SERVED was recorded as correctly
 *     denied.
 *  2. `isolationFindings` ran only on routes the crawl considered allowed. A denial page or
 *     a login redirect that still rendered another tenant's data was never scanned, which
 *     is the one page an authz bug is most likely to appear on.
 *
 * Together they made this exact case invisible: a 200 page carrying both the word
 * "Forbidden" and a cross-org marker produced no finding at all.
 *
 * The spec is exercised by running it against a stub `@playwright/test` whose `test()`
 * INVOKES the body (Phase 1's stub only recorded registrations) with a fake page, and by
 * reading the findings back out of the `testInfo.attach` the spec already writes. No regex
 * over the generated source: the assertion is on the findings the harness produces.
 *
 * The denial-redirect follow-up also checks exact destination paths and expected-finding
 * validation. The stub executes the crawl's final assertion and records its exit status.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";

import { MONKEY_ROLES } from "./monkey-test-contract.js";
import { monkeySpec } from "./monkey-test-harness-spec.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

interface Finding {
  severity: string;
  area: string;
  title: string;
  role: string;
  route: string;
}

interface CrawlResult {
  role: string;
  findings: Finding[];
  assertions: number;
  error?: { code: string; message: string };
}

interface CrawlScenario {
  destination?: string;
  status?: number;
  leak?: boolean;
  denyRoute?: string;
  expected?: unknown;
}

// Execute the generated crawl, including its final assertion. Only browser I/O is faked.
const EXECUTING_STUB = `import { writeFileSync, appendFileSync } from "node:fs";
import assert from "node:assert/strict";

const OUT = process.env.MONKEY_STUB_OUT;
writeFileSync(OUT, "");

const describeStack = [];
const registered = [];
const roleIds = JSON.parse(process.env.MONKEY_STUB_ROLE_IDS);
const scenario = JSON.parse(process.env.MONKEY_STUB_SCENARIO);
const denialBody = [
  "Forbidden",
  ...(scenario.leak === false ? [] : roleIds.map((id) => "other-org-" + id)),
].join(" ");
const allowBody = roleIds.map((id) => "own-org-" + id).join(" ");

function isDenyRoute(route) {
  return scenario.denyRoute === route || roleIds.some((id) => route === "/forbidden-to-" + id);
}

function fakeLocator(selector, route) {
  const body = isDenyRoute(route) ? denialBody : allowBody;
  return {
    count: async () => 0,
    innerText: async () => (selector === "body" ? body : ""),
    evaluateAll: async () => [],
    first: () => fakeLocator(selector, route),
    click: async () => {},
  };
}

function fakePage() {
  let requested = "/";
  let current = "/";
  return {
    goto: async (route) => {
      requested = route;
      current = isDenyRoute(route) ? (scenario.destination ?? route) : route;
      return {
        status: () => isDenyRoute(route) ? (scenario.status ?? 200) : 200,
        url: () => new URL(current, "http://127.0.0.1").href,
        request: () => ({ isNavigationRequest: () => true }),
      };
    },
    url: () => new URL(current, "http://127.0.0.1").href,
    on: () => {},
    waitForLoadState: async () => {},
    locator: (selector) => fakeLocator(selector, requested),
    // Matches against the rendered body, as the real getByText does. Stubbing this to 0
    // would leave the body-text denial heuristic (defect 1) unexercised, and the test
    // would silently prove only half of what it claims.
    getByText: (pattern) => ({
      count: async () => {
        const body = isDenyRoute(requested) ? denialBody : allowBody;
        return pattern instanceof RegExp && pattern.test(body) ? 1 : 0;
      },
    }),
    setViewportSize: async () => {},
  };
}

export function test(name, fn) {
  // Only the role crawls are exercised here; the money flow needs payment env this stub
  // deliberately does not fake.
  if (name !== "route crawl" || typeof fn !== "function") return;
  registered.push({ role: describeStack[0].split(":")[0], fn });
}
test.describe = (name, fn) => {
  describeStack.push(name);
  fn();
  describeStack.pop();
};
test.use = () => {};
test.skip = () => { throw new Error("role crawls must not skip assertions"); };

let active;
export function expect(actual, message) {
  return {
    toEqual: (expected) => {
      active.assertions++;
      assert.deepEqual(actual, expected, message);
    },
  };
}

process.once("beforeExit", async () => {
  for (const { role, fn } of registered) {
    active = { role, findings: [], assertions: 0 };
    try {
      await fn({ page: fakePage() }, {
        attach: async (name, payload) => {
          assert.equal(name, "monkey-findings.json");
          active.findings = JSON.parse(payload.body);
        },
      });
    } catch (error) {
      active.error = { code: error.code, message: error.message };
      process.exitCode = 1;
    }
    appendFileSync(OUT, JSON.stringify(active) + "\\n");
  }
});
`;

function installStub(dir: string): void {
  const stub = join(dir, "node_modules", "@playwright", "test");
  mkdirSync(stub, { recursive: true });
  writeFileSync(
    join(stub, "package.json"),
    JSON.stringify({
      name: "@playwright/test",
      version: "0.0.0-stub",
      type: "module",
      main: "index.js",
      exports: "./index.js",
    }) + "\n",
  );
  writeFileSync(join(stub, "index.js"), EXECUTING_STUB);
}

function writeRoleMatrix(dir: string, scenario: CrawlScenario): string {
  const path = join(dir, "role-matrix.json");
  writeFileSync(
    path,
    JSON.stringify({
      configured: true,
      roles: MONKEY_ROLES.map((role) => ({
        id: role.id,
        allowRoutes: ["/"],
        denyRoutes: [scenario.denyRoute ?? `/forbidden-to-${role.id}`],
        requiredText: [`own-org-${role.id}`],
        forbiddenText: [`other-org-${role.id}`],
      })),
    }) + "\n",
  );
  return path;
}

/** Run the generated spec against the executing stub and return every finding it attached. */
function crawlFindings(scenario: CrawlScenario = {}): {
  findings: Finding[];
  results: CrawlResult[];
  status: number | null;
} {
  const dir = mkdtempSync(join(tmpdir(), "kit-monkey-authz-"));
  roots.push(dir);
  const specPath = join(dir, "monkey.spec.mjs");
  const outPath = join(dir, "findings.jsonl");
  writeFileSync(
    specPath,
    ts.transpileModule(monkeySpec("// generated\n"), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText,
  );
  installStub(dir);
  const statePath = join(dir, "storage-state.json");
  writeFileSync(statePath, JSON.stringify({ cookies: [], origins: [] }));
  const expectedPath = join(dir, "expected-findings.json");
  writeFileSync(expectedPath, JSON.stringify(scenario.expected ?? []));

  const run = spawnSync(process.execPath, [specPath], {
    cwd: dir,
    encoding: "utf-8",
    timeout: 10_000,
    env: {
      ...process.env,
      MONKEY_ROLE_MATRIX: writeRoleMatrix(dir, scenario),
      MONKEY_STUB_OUT: outPath,
      MONKEY_STUB_ROLE_IDS: JSON.stringify(MONKEY_ROLES.map((role) => role.id)),
      MONKEY_STUB_SCENARIO: JSON.stringify(scenario),
      MONKEY_CUSTOMER_STATE: statePath,
      MONKEY_STAFF_STATE: statePath,
      MONKEY_OWNER_STATE: statePath,
      MONKEY_SUPERADMIN_STATE: statePath,
      MONKEY_EXPECTED_FINDINGS: expectedPath,
      MONKEY_LINK_DEPTH: "0",
      MONKEY_BASE_URL: "http://127.0.0.1",
    },
  });

  assert.ifError(run.error);
  assert.equal(run.signal, null);
  assert.equal(run.stderr, "", run.stderr);
  const raw = existsSync(outPath) ? readFileSync(outPath, "utf-8") : "";
  const results = raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CrawlResult);
  assert.deepEqual(
    results.map((result) => result.role),
    MONKEY_ROLES.map((role) => role.id),
  );
  return { findings: results.flatMap((result) => result.findings), results, status: run.status };
}

describe("the generated crawl catches a served denied route (MHB-02)", () => {
  it("a 200 denial-worded page with a cross-org marker produces critical authz findings", () => {
    const { findings, results, status } = crawlFindings();
    assert.equal(status, 1);
    for (const result of results) {
      assert.equal(result.assertions, 1);
      assert.equal(result.error?.code, "ERR_ASSERTION");
      assert.match(result.error.message, /Denied route exposed/);
    }

    const exposed = findings.filter(
      (f) => f.area === "authz" && f.title === "Denied route exposed",
    );
    assert.ok(
      exposed.length > 0,
      `a 200 on a denied route is an exposure whatever the body says: ${JSON.stringify(findings)}`,
    );
    assert.ok(exposed.every((f) => f.severity === "critical"));

    const isolation = findings.filter(
      (f) => f.area === "authz" && f.title === "Cross-org isolation marker visible",
    );
    assert.ok(
      isolation.length > 0,
      `the denial page's body must still be scanned for cross-org markers: ${JSON.stringify(findings)}`,
    );
    assert.ok(isolation.every((f) => f.severity === "critical"));

    // Every role's crawl must report it, not just the first one.
    const rolesWithFindings = new Set([...exposed, ...isolation].map((f) => f.role));
    assert.equal(rolesWithFindings.size, MONKEY_ROLES.length);
  });
});

describe("generated crawl denial redirects", () => {
  for (const destination of [
    "/admin/login-audit",
    "/reports/forbidden-attempts",
    "/admin/login",
    "/login/audit",
    "/sign-in-audit",
    "/unauthorized-users",
    "/access-denied-report",
    "/LOGIN",
    "/login/",
    "/reports?next=/login#forbidden",
  ]) {
    it(`fails when a denied route serves unauthorized content at ${destination}`, () => {
      const { findings, results, status } = crawlFindings({ destination, leak: false });
      assert.equal(status, 1, "the generated crawl assertion must reject exposed routes");
      assert.equal(findings.length, MONKEY_ROLES.length);
      for (const result of results) {
        assert.equal(result.assertions, 1);
        assert.equal(result.error?.code, "ERR_ASSERTION");
        assert.match(result.error.message, /Denied route exposed/);
        assert.deepEqual(
          result.findings.map(({ title, severity, role, route }) => ({
            title,
            severity,
            role,
            route,
          })),
          [
            {
              title: "Denied route exposed",
              severity: "critical",
              role: result.role,
              route: `/forbidden-to-${result.role}`,
            },
          ],
        );
      }
    });
  }
});

describe("generated crawl accepted denial signals", () => {
  for (const destination of [
    "/login",
    "/sign-in",
    "/unauthorized",
    "/forbidden",
    "/access-denied",
    "/login?next=%2Fadmin#form",
  ]) {
    it(`accepts an exact denial destination ${destination}`, () => {
      const { findings, results, status } = crawlFindings({ destination, leak: false });
      assert.equal(status, 0);
      assert.deepEqual(findings, []);
      assert.ok(results.every((result) => result.assertions === 1 && !result.error));
    });
  }

  for (const statusCode of [401, 403, 404]) {
    it(`accepts HTTP ${statusCode} without a redirect`, () => {
      const { findings, results, status } = crawlFindings({ status: statusCode, leak: false });
      assert.equal(status, 0);
      assert.deepEqual(findings, []);
      assert.ok(results.every((result) => result.assertions === 1 && !result.error));
    });
  }

  it("requires a pathname change even at a recognized denial destination", () => {
    const { findings, results, status } = crawlFindings({
      denyRoute: "/login",
      destination: "/login?next=%2Fadmin#form",
      leak: false,
    });
    assert.equal(status, 1);
    assert.equal(findings.length, MONKEY_ROLES.length);
    assert.ok(findings.every((finding) => finding.title === "Denied route exposed"));
    assert.ok(
      results.every((result) => result.assertions === 1 && result.error?.code === "ERR_ASSERTION"),
    );
  });
});

describe("generated crawl isolation on denial destinations", () => {
  for (const destination of ["/admin/login-audit", "/reports/forbidden-attempts"]) {
    it(`reports both exposure and isolation findings at ${destination}`, () => {
      const { findings, results, status } = crawlFindings({ destination });
      assert.equal(status, 1);
      assert.equal(findings.length, MONKEY_ROLES.length * 2);
      for (const result of results) {
        assert.equal(result.assertions, 1);
        assert.equal(result.error?.code, "ERR_ASSERTION");
        assert.deepEqual(result.findings.map((finding) => finding.title).sort(), [
          "Cross-org isolation marker visible",
          "Denied route exposed",
        ]);
        assert.ok(result.findings.every((finding) => finding.severity === "critical"));
      }
    });
  }

  it("keeps isolation assertions active after a login redirect", () => {
    const { findings, results, status } = crawlFindings({ destination: "/login" });
    assert.equal(status, 1);
    assert.equal(findings.length, MONKEY_ROLES.length);
    assert.ok(
      findings.every(
        (finding) =>
          finding.title === "Cross-org isolation marker visible" && finding.severity === "critical",
      ),
    );
    assert.ok(
      results.every((result) => result.assertions === 1 && result.error?.code === "ERR_ASSERTION"),
    );
  });
});

describe("generated crawl expected findings", () => {
  const reason = "Approved fixture exposure for this regression test only.";
  const expected = MONKEY_ROLES.map((role) => ({
    title: "Denied route exposed",
    role: role.id,
    route: `/forbidden-to-${role.id}`,
    reason,
  }));

  it("accepts exact expected findings with a specific reason", () => {
    const { findings, results, status } = crawlFindings({
      destination: "/admin/login-audit",
      leak: false,
      expected,
    });
    assert.equal(status, 0);
    assert.deepEqual(findings, []);
    assert.ok(results.every((result) => result.assertions === 1 && !result.error));
  });

  it("keeps other roles' findings when an exception covers only public", () => {
    const { findings, results, status } = crawlFindings({
      destination: "/reports/forbidden-attempts",
      leak: false,
      expected: [expected[0]],
    });
    assert.equal(status, 1);
    assert.deepEqual(results[0].findings, []);
    assert.equal(results[0].assertions, 1);
    assert.equal(results[0].error, undefined);
    assert.equal(findings.length, MONKEY_ROLES.length - 1);
    assert.ok(
      findings.every(
        (finding) => finding.title === "Denied route exposed" && finding.role !== "public",
      ),
    );
    assert.ok(
      results
        .slice(1)
        .every((result) => result.assertions === 1 && result.error?.code === "ERR_ASSERTION"),
    );
  });

  for (const invalid of [
    { entries: [{ reason }], error: /exact title, role, and route/ },
    {
      entries: expected.map(({ title, role, route }) => ({ title, role, route })),
      error: /specific reason/,
    },
  ]) {
    it(`rejects invalid expected findings: ${invalid.error.source}`, () => {
      const { results, status } = crawlFindings({
        destination: "/admin/login-audit",
        leak: false,
        expected: invalid.entries,
      });
      assert.equal(status, 1);
      for (const result of results) {
        assert.ok(result.error, "invalid expectations must fail validation");
        assert.match(result.error.message, invalid.error);
        assert.equal(result.assertions, 0, "expectations are validated before the crawl assertion");
      }
    });
  }
});
