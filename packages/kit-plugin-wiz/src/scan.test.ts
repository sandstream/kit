import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeClient, recordWizIssues, fetchIssues, type WizIssue } from "./scan.js";

const SAMPLE_ISSUE: WizIssue = {
  id: "wiz-issue-1",
  severity: "HIGH",
  status: "OPEN",
  type: "WIZ_CONTROL",
  entitySnapshot: {
    type: "VIRTUAL_MACHINE",
    name: "prod-app-01",
    cloudPlatform: "AWS",
    subscriptionExternalId: "111122223333",
    region: "us-east-1",
  },
  controlId: "wc-id-1",
  controlName: "VM exposes SSH to the internet",
  createdAt: "2026-06-08T10:00:00Z",
};

describe("makeClient", () => {
  for (const source of ["explicit", "env"]) {
    it(`masks a known ${source} client secret in an auth error`, async (t) => {
      const clientSecret = "wiz:v042";
      const clientId = "public-client-id";
      const priorSecret = process.env.WIZ_CLIENT_SECRET;
      process.env.WIZ_CLIENT_SECRET = source === "env" ? clientSecret : "unused-env-secret";
      t.after(() => {
        if (priorSecret === undefined) delete process.env.WIZ_CLIENT_SECRET;
        else process.env.WIZ_CLIENT_SECRET = priorSecret;
      });
      const fetchMock = t.mock.method(
        globalThis,
        "fetch",
        async (_url: string | URL | Request, init?: RequestInit) => {
          assert.ok(init && typeof init.body === "string");
          const body = new URLSearchParams(init.body);
          assert.equal(body.get("client_secret"), clientSecret);
          assert.equal(body.get("client_id"), clientId);
          return new Response(`request_id=req_auth client=${clientId} rejected ${clientSecret}`, {
            status: 401,
          });
        },
      );
      await assert.rejects(
        () =>
          makeClient({
            clientId,
            clientSecret: source === "explicit" ? clientSecret : undefined,
            apiUrl: "https://api.example.test/graphql",
            authUrl: "https://auth.example.test/token",
          }),
        { message: `Wiz auth 401: request_id=req_auth client=${clientId} rejected [REDACTED]` },
      );
      assert.equal(fetchMock.mock.callCount(), 1);
    });
  }

  it("refuses without WIZ_CLIENT_ID / WIZ_CLIENT_SECRET", async () => {
    const prevId = process.env.WIZ_CLIENT_ID;
    const prevSecret = process.env.WIZ_CLIENT_SECRET;
    delete process.env.WIZ_CLIENT_ID;
    delete process.env.WIZ_CLIENT_SECRET;
    try {
      await assert.rejects(() => makeClient({}), /WIZ_CLIENT_ID \+ WIZ_CLIENT_SECRET required/);
    } finally {
      if (prevId !== undefined) process.env.WIZ_CLIENT_ID = prevId;
      if (prevSecret !== undefined) process.env.WIZ_CLIENT_SECRET = prevSecret;
    }
  });

  it("refuses without WIZ_API_URL", async () => {
    await assert.rejects(
      () => makeClient({ clientId: "x", clientSecret: "y" }),
      /WIZ_API_URL required/,
    );
  });

  it("surfaces auth-endpoint failure", async () => {
    await assert.rejects(() =>
      makeClient({
        clientId: "x",
        clientSecret: "y",
        apiUrl: "https://api.demo.wiz.io/graphql",
        authUrl: "https://127.0.0.1:1/oauth/token",
      }),
    );
  });
});

describe("fetchIssues", () => {
  for (const status of [403, 200]) {
    it(`masks the minted access token in a ${status} issue response`, async (t) => {
      const accessToken = "access:v42";
      const fetchMock = t.mock.method(
        globalThis,
        "fetch",
        async (url: string | URL | Request, init?: RequestInit) => {
          if (String(url) === "https://auth.example.test/token") {
            return Response.json({ access_token: accessToken });
          }
          assert.equal(String(url), "https://api.example.test/graphql");
          assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${accessToken}`);
          const message = `request_id=req_issues rejected ${accessToken}`;
          return status === 403
            ? new Response(message, { status })
            : Response.json({ errors: [{ message }, { message: "retry=false" }, {}] });
        },
      );
      const client = await makeClient({
        clientId: "client-id",
        clientSecret: "client-secret-fixture",
        apiUrl: "https://api.example.test/graphql",
        authUrl: "https://auth.example.test/token",
      });
      assert.equal(client.accessToken, accessToken);
      await assert.rejects(() => fetchIssues(client), {
        message:
          status === 403
            ? "Wiz GraphQL 403: request_id=req_issues rejected [REDACTED]"
            : "Wiz GraphQL errors: request_id=req_issues rejected [REDACTED]; retry=false; ",
      });
      assert.equal(fetchMock.mock.callCount(), 2);
    });
  }

  it("throws on unreachable API", async () => {
    await assert.rejects(() =>
      fetchIssues({ apiUrl: "https://127.0.0.1:1/graphql", accessToken: "x" }, { limit: 5 }),
    );
  });
});

describe("unreadable error responses", () => {
  for (const [label, call] of [
    [
      "auth",
      () =>
        makeClient({
          clientId: "client-id",
          clientSecret: "fixture-secret",
          apiUrl: "https://api.example.test/graphql",
          authUrl: "https://auth.example.test/token",
        }),
    ],
    [
      "GraphQL",
      () =>
        fetchIssues({ apiUrl: "https://api.example.test/graphql", accessToken: "fixture-token" }),
    ],
  ] as const) {
    it(`${label} keeps the no-body fallback`, async (t) => {
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
      await assert.rejects(call, { message: `Wiz ${label} 403: <no body>` });
    });
  }
});

describe("recordWizIssues", () => {
  it("writes one JSONL line per issue", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-wiz-"));
    try {
      const { written } = await recordWizIssues([SAMPLE_ISSUE], dir);
      assert.equal(written, 1);
      const text = readFileSync(join(dir, ".kit-scan-results.jsonl"), "utf-8");
      const line = JSON.parse(text.trim());
      assert.equal(line.source, "wiz");
      assert.equal(line.severity, "high");
      assert.equal(line.cloud_platform, "AWS");
      assert.equal(line.title, "VM exposes SSH to the internet");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns written:0 for empty input", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-wiz-"));
    try {
      const { written } = await recordWizIssues([], dir);
      assert.equal(written, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
