import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  checkDeploy,
  inferVercelRemoteEnv,
  parseVercelEnvNames,
  type DeployListEnv,
} from "./check-deploy.js";
import type { DeployConfig } from "./config.js";

const config: DeployConfig = {
  vercel: {
    scope: "example-team",
    environments: {
      production: {
        project: "app-prod",
        required: ["NEXT_PUBLIC_SENTRY_DSN", "NEXT_PUBLIC_SENTRY_ENVIRONMENT"],
      },
      staging: {
        project: "app-stg",
        required: ["NEXT_PUBLIC_SENTRY_DSN", "NEXT_PUBLIC_SENTRY_ENVIRONMENT"],
      },
    },
  },
};

function lister(namesByProject: Record<string, string[]>): DeployListEnv {
  return async (target) => ({
    ok: true,
    names: namesByProject[target.project] ?? [],
    detail: "listed",
  });
}

describe("parseVercelEnvNames", () => {
  it("extracts names from JSON without surfacing values", () => {
    const names = parseVercelEnvNames(
      JSON.stringify([
        { key: "NEXT_PUBLIC_SENTRY_DSN", value: "https://secret.example/1" },
        { name: "NEXT_PUBLIC_POSTHOG_KEY", value: "phc_secret" },
      ]),
    );
    assert.deepEqual(names, ["NEXT_PUBLIC_POSTHOG_KEY", "NEXT_PUBLIC_SENTRY_DSN"]);
    assert.equal(names.includes("phc_secret"), false);
    assert.equal(
      names.some((name) => name.includes("secret.example")),
      false,
    );
  });

  it("extracts names from table output", () => {
    const names = parseVercelEnvNames(`
Vercel CLI 99.0.0
name                              environments
NEXT_PUBLIC_SENTRY_ENVIRONMENT    production
NEXT_PUBLIC_POSTHOG_HOST          production preview
`);
    assert.deepEqual(names, ["NEXT_PUBLIC_POSTHOG_HOST", "NEXT_PUBLIC_SENTRY_ENVIRONMENT"]);
  });
});

describe("checkDeploy", () => {
  it("is a no-op row when [deploy] is absent", async () => {
    const results = await checkDeploy(undefined, process.cwd(), { listVercelEnvNames: lister({}) });
    assert.equal(results.length, 1);
    assert.equal(results[0].status, "skip");
    assert.match(results[0].detail, /\[deploy\]/);
  });

  it("fails with named missing keys and redeploy note for NEXT_PUBLIC build-time keys", async () => {
    const results = await checkDeploy(config, process.cwd(), {
      listVercelEnvNames: lister({
        "app-prod": ["NEXT_PUBLIC_SENTRY_DSN", "NEXT_PUBLIC_SENTRY_ENVIRONMENT"],
        "app-stg": ["NEXT_PUBLIC_SENTRY_DSN"],
      }),
    });
    const staging = results.find((r) => r.environment === "staging");
    assert.equal(staging?.status, "fail");
    assert.deepEqual(staging?.missing, ["NEXT_PUBLIC_SENTRY_ENVIRONMENT"]);
    assert.deepEqual(staging?.buildTime, ["NEXT_PUBLIC_SENTRY_ENVIRONMENT"]);
    assert.match(staging?.detail ?? "", /redeploy/);
  });

  it("warns on remote drift even when each environment meets its own required list", async () => {
    const results = await checkDeploy(
      {
        vercel: {
          environments: {
            production: { project: "app-prod", required: ["A_KEY"] },
            staging: { project: "app-stg", required: ["A_KEY"] },
          },
        },
      },
      process.cwd(),
      {
        listVercelEnvNames: lister({
          "app-prod": ["A_KEY", "B_KEY"],
          "app-stg": ["A_KEY"],
        }),
      },
    );
    const staging = results.find((r) => r.environment === "staging");
    assert.equal(staging?.status, "warn");
    assert.deepEqual(staging?.drift, ["B_KEY"]);
  });

  it("suppresses drift for declared environment-specific keys", async () => {
    const results = await checkDeploy(
      {
        vercel: {
          environment_specific: ["B_KEY"],
          environments: {
            production: { project: "app-prod", required: ["A_KEY"] },
            staging: { project: "app-stg", required: ["A_KEY"] },
          },
        },
      },
      process.cwd(),
      {
        listVercelEnvNames: lister({
          "app-prod": ["A_KEY", "B_KEY"],
          "app-stg": ["A_KEY"],
        }),
      },
    );
    assert.ok(results.every((r) => r.status === "pass"));
  });

  it("fails closed when the provider CLI cannot list remote names", async () => {
    const results = await checkDeploy(config, process.cwd(), {
      listVercelEnvNames: async () => ({
        ok: false,
        names: [],
        detail: "vercel env ls failed: login required",
        didNotRun: true,
      }),
    });
    assert.ok(results.every((r) => r.status === "fail"));
    assert.ok(results.every((r) => r.didNotRun === true));
  });

  it("uses the Vercel API project selector when VERCEL_TOKEN is available", async () => {
    const priorToken = process.env.VERCEL_TOKEN;
    const priorFetch = globalThis.fetch;
    const urls: string[] = [];
    process.env.VERCEL_TOKEN = "test-token";
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      urls.push(String(input));
      const headers = init?.headers;
      assert.ok(headers && typeof headers === "object" && !Array.isArray(headers));
      assert.equal((headers as Record<string, string>).Authorization, "Bearer test-token");
      return new Response(
        JSON.stringify({
          envs: [
            { key: "A_KEY", target: ["production"], value: "secret-never-output" },
            { key: "B_KEY", target: ["preview"], value: "other-secret" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    try {
      const results = await checkDeploy(
        {
          vercel: {
            team_id: "team_123",
            environments: {
              production: {
                project: "app-prod",
                remote_env: "production",
                required: ["A_KEY"],
              },
            },
          },
        },
        process.cwd(),
      );
      assert.equal(results[0].status, "pass");
      assert.match(urls[0] ?? "", /\/v9\/projects\/app-prod\/env\?decrypt=false&teamId=team_123$/);
      assert.equal(results[0].detail.includes("secret-never-output"), false);
    } finally {
      if (priorToken === undefined) delete process.env.VERCEL_TOKEN;
      else process.env.VERCEL_TOKEN = priorToken;
      globalThis.fetch = priorFetch;
    }
  });
});

describe("inferVercelRemoteEnv", () => {
  it("only infers Vercel's native target envs and conservative aliases", () => {
    assert.equal(inferVercelRemoteEnv("production"), "production");
    assert.equal(inferVercelRemoteEnv("prod"), "production");
    assert.equal(inferVercelRemoteEnv("dev"), "development");
    assert.equal(inferVercelRemoteEnv("staging"), null);
  });
});
