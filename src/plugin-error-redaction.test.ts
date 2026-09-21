import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { redactSecrets } from "./utils/redactSecrets.js";

// These clients ship independently. Compare their real error paths with core
// without introducing a runtime dependency on core into any plugin package.
const clientToken = "client-fixture-" + "z".repeat(20);
const baseUrl = "https://api.example.test";
const bearerValue = "q".repeat(9) + "_-+/.==";
const queryValue = "q".repeat(5) + "_-+/%.x";
const diagnostic = "request_id=req_compat ";

interface RedactionCase {
  name: string;
  input: string;
  expected: string;
}

const cases: RedactionCase[] = [
  ...["Bearer", "bearer", "bEaReR"].map((scheme) => ({
    name: `${scheme} opaque credential at the 16-character boundary`,
    input: `Authorization: ${scheme}\t${bearerValue}`,
    expected: "Authorization: Bearer [REDACTED]",
  })),
  ...["token", "access_token", "api_key", "apikey", "auth_token", "session_token"].flatMap(
    (keyword) =>
      [keyword, keyword.toUpperCase(), keyword[0].toUpperCase() + keyword.slice(1)].map((key) => ({
        name: `${key} URL value at the 12-character boundary`,
        input: `https://hooks.example.test/cb?state=ok&${key}=${queryValue}&page=2#end`,
        expected: `https://hooks.example.test/cb?state=ok&${key}=[REDACTED]&page=2#end`,
      })),
  ),
  {
    name: "query token in the first parameter with percent-encoded bytes",
    input: `https://hooks.example.test/cb?token=${queryValue}%2B%2F%3D&state=ok`,
    expected: "https://hooks.example.test/cb?token=[REDACTED]&state=ok",
  },
  {
    name: "multiple credentials in one error",
    input: `Bearer ${bearerValue}; bearer ${bearerValue}; ?token=${queryValue}&apikey=${queryValue}`,
    expected: "Bearer [REDACTED]; Bearer [REDACTED]; ?token=[REDACTED]&apikey=[REDACTED]",
  },
  {
    name: "redaction before response-body truncation",
    input: `Bearer ${"q".repeat(220)} retry=false`,
    expected: "Bearer [REDACTED] retry=false",
  },
  {
    name: "known client credential without a recognizable pattern",
    input: `rejected credential ${clientToken}`,
    expected: "rejected credential [REDACTED]",
  },
  {
    name: "provider credential patterns shared by the plugin clients",
    input: [
      "sk_" + "test_" + "q".repeat(20),
      "whsec_" + "q".repeat(20),
      "ghp_" + "q".repeat(30),
      "github_pat_" + "q".repeat(60),
      "sk-proj-" + "q".repeat(20),
      "eyJ" + "q".repeat(10) + "." + "q".repeat(10) + "." + "q".repeat(10),
    ].join(" "),
    expected: Array(6).fill("[REDACTED]").join(" "),
  },
  {
    name: "existing URL password masking",
    input: ["postgres://user:", "password-fixture", "@db.example.test/app"].join(""),
    expected: "postgres://user:[REDACTED]@db.example.test/app",
  },
  {
    name: "existing URL userinfo token masking",
    input: `https://${"q".repeat(16)}@git.example.test/repo`,
    expected: "https://[REDACTED]@git.example.test/repo",
  },
  ...[
    `Authorization: Bearer ${"q".repeat(15)}`,
    `https://hooks.example.test/cb?token=${"q".repeat(11)}&state=ok`,
    `https://hooks.example.test/cb?not_token=${queryValue}`,
    "https://user@example.test/repo",
    `GITHUB_SHA=${"a".repeat(40)} KIT_POLICY_HASH=${"b".repeat(24)}`,
    `commit ${"c".repeat(40)} rejected`,
    "permission denied; retry=false",
  ].map((input) => ({ name: `preserves non-secret context: ${input}`, input, expected: input })),
];

interface Client {
  headers: HeadersInit;
}

interface ErrorPath {
  plugin: string;
  operation: string;
  config: Record<string, string>;
  args: string[];
  prefix: string;
  response?: (text: string) => Response;
}

const paths: ErrorPath[] = [
  {
    plugin: "vercel",
    operation: "listProjects",
    config: { baseUrl, token: clientToken, teamId: "" },
    args: [],
    prefix: "/v9/projects returned 403: ",
  },
  {
    plugin: "github",
    operation: "listRepoSecrets",
    config: { baseUrl, token: clientToken },
    args: ["owner", "repo"],
    prefix: "GET /repos/owner/repo/actions/secrets returned 403: ",
  },
  {
    plugin: "stripe",
    operation: "getAccount",
    config: { baseUrl, secretKey: clientToken },
    args: [],
    prefix: "GET /v1/account returned 403: ",
  },
  {
    plugin: "supabase",
    operation: "listProjects",
    config: { baseUrl, accessToken: clientToken },
    args: [],
    prefix: "Supabase Management API /v1/projects returned 403: ",
  },
  {
    plugin: "sentry",
    operation: "listOrganizations",
    config: { host: baseUrl, token: clientToken },
    args: [],
    prefix: "GET /api/0/organizations/ returned 403: ",
  },
  {
    plugin: "fly",
    operation: "listMachines",
    config: { machinesUrl: baseUrl, token: clientToken },
    args: ["app"],
    prefix: "GET /apps/app/machines returned 403: ",
  },
  {
    plugin: "fly",
    operation: "listAppSecrets",
    config: { graphqlUrl: baseUrl, token: clientToken },
    args: ["app"],
    prefix: "Fly GraphQL returned 403: ",
  },
  {
    plugin: "fly",
    operation: "listAppSecrets",
    config: { graphqlUrl: baseUrl, token: clientToken },
    args: ["app"],
    prefix: "Fly GraphQL errors: ",
    response: (text) => Response.json({ errors: [{ message: text }] }),
  },
  {
    plugin: "cloudflare",
    operation: "listApiTokens",
    config: { baseUrl, apiToken: clientToken },
    args: [],
    prefix: "GET /user/tokens returned 403: ",
  },
  ...[200, 404].map((status) => ({
    plugin: "cloudflare",
    operation: "listApiTokens",
    config: { baseUrl, apiToken: clientToken },
    args: [],
    prefix: "Cloudflare API error on /user/tokens: 1000: ",
    response: (text: string) =>
      Response.json({ success: false, errors: [{ code: 1000, message: text }] }, { status }),
  })),
];

for (const path of paths) {
  describe(`${path.plugin} ${path.operation}: ${path.prefix}`, async () => {
    // Source runs must never pick up stale dist output. Compiled CI tests use
    // the package builds, matching the artifacts shipped by each package.
    const entry = import.meta.url.endsWith(".ts") ? "src/mgmt-api.ts" : "dist/mgmt-api.js";
    const api = await import(
      new URL(`../packages/kit-plugin-${path.plugin}/${entry}`, import.meta.url).href
    );
    const makeClient = api.makeClient as (config: Record<string, string>) => Client;
    const call = api[path.operation] as (client: Client, ...args: string[]) => Promise<unknown>;

    for (const fixture of cases) {
      it(fixture.name, async (t) => {
        const input = diagnostic + fixture.input;
        const expected = diagnostic + fixture.expected;
        assert.equal(redactSecrets(input, [clientToken]), expected, "core contract changed");
        const fetchMock = t.mock.method(globalThis, "fetch", async () =>
          path.response ? path.response(input) : new Response(input, { status: 403 }),
        );

        await assert.rejects(
          () => call(makeClient(path.config), ...path.args),
          (err: unknown) => {
            assert.ok(err instanceof Error);
            assert.equal(err.message, path.prefix + expected);
            return true;
          },
        );
        assert.equal(fetchMock.mock.callCount(), 1, "must exercise the failed response");
      });
    }

    it("retains known-secret masking for manually constructed clients", async (t) => {
      const client = { ...makeClient(path.config) };
      client.headers = new Headers({ authorization: `bearer ${clientToken}` });
      const input = diagnostic + `rejected credential ${clientToken}`;
      t.mock.method(globalThis, "fetch", async () =>
        path.response ? path.response(input) : new Response(input, { status: 403 }),
      );
      await assert.rejects(
        () => call(client, ...path.args),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.equal(err.message, path.prefix + diagnostic + "rejected credential [REDACTED]");
          return true;
        },
      );
    });
  });
}

const scanPaths: Omit<ErrorPath, "args">[] = [
  {
    plugin: "snyk",
    operation: "fetchSnykIssues",
    config: { token: clientToken, orgSlug: "org", apiBase: baseUrl },
    prefix: "Snyk API 403: ",
  },
  {
    plugin: "wiz",
    operation: "makeClient",
    config: { clientId: "client-id", clientSecret: clientToken, apiUrl: baseUrl, authUrl: baseUrl },
    prefix: "Wiz auth 403: ",
  },
  {
    plugin: "wiz",
    operation: "fetchIssues",
    config: { accessToken: clientToken, apiUrl: baseUrl },
    prefix: "Wiz GraphQL 403: ",
  },
  {
    plugin: "wiz",
    operation: "fetchIssues",
    config: { accessToken: clientToken, apiUrl: baseUrl },
    prefix: "Wiz GraphQL errors: ",
    response: (text) => Response.json({ errors: [{ message: text }] }),
  },
];

for (const path of scanPaths) {
  describe(`${path.plugin} ${path.operation}: ${path.prefix}`, async () => {
    const entry = import.meta.url.endsWith(".ts") ? "src/scan.ts" : "dist/scan.js";
    const api = await import(
      new URL(`../packages/kit-plugin-${path.plugin}/${entry}`, import.meta.url).href
    );
    const call = api[path.operation] as (config: Record<string, string>) => Promise<unknown>;

    for (const fixture of cases) {
      it(fixture.name, async (t) => {
        const input = diagnostic + fixture.input;
        const expected = diagnostic + fixture.expected;
        assert.equal(redactSecrets(input, [clientToken]), expected, "core contract changed");
        const fetchMock = t.mock.method(globalThis, "fetch", async () =>
          path.response ? path.response(input) : new Response(input, { status: 403 }),
        );

        await assert.rejects(
          () => call(path.config),
          (err: unknown) => {
            assert.ok(err instanceof Error);
            assert.equal(err.message, path.prefix + expected);
            return true;
          },
        );
        assert.equal(fetchMock.mock.callCount(), 1, "must exercise the failed response");
      });
    }
  });
}
