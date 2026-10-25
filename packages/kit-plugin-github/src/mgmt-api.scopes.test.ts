import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createOrUpdateEnvironmentSecret,
  createOrUpdateOrgSecret,
  deleteEnvironmentSecret,
  deleteOrgSecret,
  listEnvironmentSecrets,
  listOrgSecrets,
  makeClient,
} from "./mgmt-api.js";

// Paths follow docs.github.com/en/rest/actions/secrets (2026-10-23).
type Call = { method: string; path: string };

async function withGitHub(
  run: (client: ReturnType<typeof makeClient>, calls: Call[]) => Promise<void>,
  env: Record<string, string> = {},
) {
  const priorFetch = globalThis.fetch;
  const saved = { ro: process.env.KIT_READ_ONLY, deny: process.env.KIT_POLICY_DENY };
  delete process.env.KIT_READ_ONLY;
  delete process.env.KIT_POLICY_DENY;
  Object.assign(process.env, env);
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    calls.push({ method: init?.method ?? "GET", path });
    const json = path.endsWith("/public-key")
      ? { key_id: "k1", key: "AAAA" }
      : { secrets: [{ name: "S", created_at: "", updated_at: "" }] };
    return new Response(JSON.stringify(json), { status: 200 });
  }) as typeof fetch;
  try {
    await run(
      makeClient({ token: "ghp_" + "x".repeat(36), baseUrl: "https://api.github.test" }),
      calls,
    );
  } finally {
    globalThis.fetch = priorFetch;
    for (const [k, v] of [
      ["KIT_READ_ONLY", saved.ro],
      ["KIT_POLICY_DENY", saved.deny],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("environment secrets", () => {
  it("lists and deletes under /repos/{owner}/{repo}/environments/{env}/secrets", async () => {
    await withGitHub(async (client, calls) => {
      assert.deepEqual(
        (
          await listEnvironmentSecrets(client, { owner: "o", repo: "r", environment: "prod env" })
        ).map((s) => s.name),
        ["S"],
      );
      await deleteEnvironmentSecret(
        client,
        { owner: "o", repo: "r", environment: "prod env" },
        "S",
      );
      assert.deepEqual(calls, [
        { method: "GET", path: "/repos/o/r/environments/prod%20env/secrets" },
        { method: "DELETE", path: "/repos/o/r/environments/prod%20env/secrets/S" },
      ]);
    });
  });

  it("encrypts with the ENVIRONMENT's public key, not the repository's", async () => {
    await withGitHub(async (client, calls) => {
      // libsodium-wrappers is an optional peer and absent here, so the write stops after the key.
      await assert.rejects(
        createOrUpdateEnvironmentSecret(
          client,
          { owner: "o", repo: "r", environment: "prod" },
          "S",
          "v",
        ),
        /libsodium-wrappers not installed/,
      );
      assert.deepEqual(calls, [
        { method: "GET", path: "/repos/o/r/environments/prod/secrets/public-key" },
      ]);
    });
  });
});

describe("organization secrets", () => {
  it("lists and deletes under /orgs/{org}/actions/secrets, with the org public key for writes", async () => {
    await withGitHub(async (client, calls) => {
      assert.equal((await listOrgSecrets(client, "acme")).length, 1);
      await deleteOrgSecret(client, "acme", "S");
      await assert.rejects(
        createOrUpdateOrgSecret(client, "acme", "S", "v", { visibility: "private" }),
        /libsodium-wrappers not installed/,
      );
      assert.deepEqual(
        calls.map((c) => `${c.method} ${c.path}`),
        [
          "GET /orgs/acme/actions/secrets",
          "DELETE /orgs/acme/actions/secrets/S",
          "GET /orgs/acme/actions/secrets/public-key",
        ],
      );
    });
  });

  it("refuses an empty 'selected' visibility before any request", async () => {
    await withGitHub(async (client, calls) => {
      await assert.rejects(
        createOrUpdateOrgSecret(client, "acme", "S", "v", {
          visibility: "selected",
          selectedRepositoryIds: [],
        }),
        /needs at least one repository id/,
      );
      assert.equal(calls.length, 0);
    });
  });

  it("gates on org_secret_* — pre-approving env_set does not open the org", async () => {
    await withGitHub(
      async (client, calls) => {
        await assert.rejects(deleteOrgSecret(client, "acme", "S"), /org_secret_unset/);
        await deleteEnvironmentSecret(client, { owner: "o", repo: "r", environment: "prod" }, "S");
        assert.deepEqual(
          calls.map((c) => c.method),
          ["DELETE"],
        );
      },
      { KIT_POLICY_DENY: "github:org_secret_unset" },
    );
  });
});
