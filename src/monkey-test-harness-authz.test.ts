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

/**
 * A stub `@playwright/test` that RUNS each registered test body against a fake page.
 *
 * The fake page answers every navigation with HTTP 200 and no redirect. Deny routes get a
 * body carrying both a denial word and every role's cross-org marker; allow routes get a
 * clean body with the positive-control markers, so the only findings under test are the
 * authz ones. Findings reach the test through the spec's own attach call.
 */
const EXECUTING_STUB = `import { writeFileSync, appendFileSync } from "node:fs";

const OUT = process.env.MONKEY_STUB_OUT;
writeFileSync(OUT, "");

const describeStack = [];
const roleIds = JSON.parse(process.env.MONKEY_STUB_ROLE_IDS);
const denialBody = [
  "Forbidden",
  ...roleIds.map((id) => "other-org-" + id),
].join(" ");
const allowBody = roleIds.map((id) => "own-org-" + id).join(" ");

function isDenyRoute(route) {
  return String(route).includes("/forbidden-to-");
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
  let current = "/";
  return {
    goto: async (route) => {
      current = route;
      return {
        status: () => 200,
        url: () => "http://127.0.0.1" + route,
        request: () => ({ isNavigationRequest: () => true }),
      };
    },
    // No redirect: the app served exactly what was asked for.
    url: () => "http://127.0.0.1" + current,
    on: () => {},
    waitForLoadState: async () => {},
    locator: (selector) => fakeLocator(selector, current),
    // Matches against the rendered body, as the real getByText does. Stubbing this to 0
    // would leave the body-text denial heuristic (defect 1) unexercised, and the test
    // would silently prove only half of what it claims.
    getByText: (pattern) => ({
      count: async () => {
        const body = isDenyRoute(current) ? denialBody : allowBody;
        return pattern instanceof RegExp && pattern.test(body) ? 1 : 0;
      },
    }),
    setViewportSize: async () => {},
  };
}

const testInfo = {
  // The spec attaches pretty-printed JSON; re-serialize compactly so the transcript stays
  // one finding array per line.
  attach: async (name, payload) => {
    appendFileSync(OUT, JSON.stringify(JSON.parse(payload.body)) + "\\n");
  },
};

export function test(name, fn) {
  const path = [...describeStack];
  // Only the role crawls are exercised here; the money flow needs payment env this stub
  // deliberately does not fake.
  if (name !== "route crawl" || typeof fn !== "function") return;
  const run = fn({ page: fakePage() }, testInfo);
  if (run && typeof run.then === "function") {
    run.catch((error) => {
      appendFileSync(OUT, JSON.stringify([{ stubError: String(error), path, name }]) + "\\n");
    });
  }
}
test.describe = (name, fn) => {
  describeStack.push(name);
  fn();
  describeStack.pop();
};
test.use = () => {};
test.skip = () => {};

const chain = new Proxy(() => chain, { get: () => chain, apply: () => chain });
export const expect = chain;
export const devices = new Proxy({}, { get: () => ({}) });
export const defineConfig = (config) => config;
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

function writeRoleMatrix(dir: string): string {
  const path = join(dir, "role-matrix.json");
  writeFileSync(
    path,
    JSON.stringify({
      configured: true,
      roles: MONKEY_ROLES.map((role) => ({
        id: role.id,
        allowRoutes: ["/"],
        denyRoutes: [`/forbidden-to-${role.id}`],
        requiredText: [`own-org-${role.id}`],
        forbiddenText: [`other-org-${role.id}`],
      })),
    }) + "\n",
  );
  return path;
}

/** Run the generated spec against the executing stub and return every finding it attached. */
function crawlFindings(): { findings: Finding[]; stderr: string } {
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

  const run = spawnSync(process.execPath, [specPath], {
    cwd: dir,
    encoding: "utf-8",
    env: {
      ...process.env,
      MONKEY_ROLE_MATRIX: writeRoleMatrix(dir),
      MONKEY_STUB_OUT: outPath,
      MONKEY_STUB_ROLE_IDS: JSON.stringify(MONKEY_ROLES.map((role) => role.id)),
      MONKEY_EXPECTED_FINDINGS: "",
      MONKEY_LINK_DEPTH: "0",
      MONKEY_BASE_URL: "http://127.0.0.1",
    },
  });

  const raw = existsSync(outPath) ? readFileSync(outPath, "utf-8") : "";
  const findings = raw
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => JSON.parse(line) as Finding[]);
  return { findings, stderr: run.stderr ?? "" };
}

describe("the generated crawl catches a served denied route (MHB-02)", () => {
  it("a 200 denial-worded page with a cross-org marker produces critical authz findings", () => {
    const { findings, stderr } = crawlFindings();
    assert.equal(stderr, "", stderr);
    assert.deepEqual(
      findings.filter((f) => "stubError" in (f as object)),
      [],
      "the spec body must run cleanly under the stub",
    );

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
