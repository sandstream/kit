/**
 * The provisioning adapters' vendor API calls are bounded: a vendor endpoint
 * that accepts the connection and never answers must fail `provision()` with
 * an error, not hang `kit add`.
 *
 * The test points each adapter at a local stub server that never answers and
 * shortens the requested `AbortSignal.timeout` so the run stays fast; it also
 * records the value each call asked for.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { upstashRedisAdapter } from "./upstash-redis.js";
import { neonDbAdapter } from "./neon-db.js";
import { planetscaleDbAdapter } from "./planetscale-db.js";
import type { ServiceAdapter, ProvisionResult } from "./types.js";

const HUNG = Symbol("hung");
const GUARD_MS = 5_000;
const SHORT_TIMEOUT_MS = 200;

let server: Server;
let port = 0;
const realFetch = globalThis.fetch;
const realTimeout = AbortSignal.timeout.bind(AbortSignal);
let requested: number[] = [];

/** Answers only PlanetScale's create-database call, so the second PlanetScale call is reached. */
function stub(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) {
  if (req.url?.endsWith("/databases")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: "d1", name: "stub-db" }));
  }
  // Every other request is accepted and never answered.
}

async function provisionOrHang(adapter: ServiceAdapter, env: Record<string, string>) {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<typeof HUNG>((resolve) => {
    timer = setTimeout(() => resolve(HUNG), GUARD_MS);
  });
  const ctx = { projectPath: "/tmp/kit-timeout-test", projectName: "t", existingEnv: env };
  try {
    return await Promise.race<ProvisionResult | typeof HUNG>([adapter.provision(ctx), guard]);
  } finally {
    clearTimeout(timer);
  }
}

describe("provisioning adapter fetches time out", () => {
  // A fresh server (and port) per case, so no keep-alive socket from an
  // earlier case is reused after it was torn down.
  beforeEach(async () => {
    server = createServer(stub);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
    requested = [];
    globalThis.fetch = (input, init) =>
      realFetch(`http://127.0.0.1:${port}${new URL(String(input)).pathname}`, init);
    AbortSignal.timeout = (ms: number) => {
      requested.push(ms);
      return realTimeout(SHORT_TIMEOUT_MS);
    };
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
    server.closeAllConnections();
    server.close();
  });

  const cases: {
    name: string;
    adapter: ServiceAdapter;
    env: Record<string, string>;
    calls: number;
  }[] = [
    {
      name: "upstash/redis create database",
      adapter: upstashRedisAdapter,
      env: { UPSTASH_EMAIL: "a@example.com", UPSTASH_API_KEY: "k" },
      calls: 1,
    },
    {
      name: "neon/db create project",
      adapter: neonDbAdapter,
      env: { NEON_API_KEY: "k" },
      calls: 1,
    },
    {
      name: "planetscale/db create password (after create database answers)",
      adapter: planetscaleDbAdapter,
      env: {
        PLANETSCALE_SERVICE_TOKEN_ID: "id",
        PLANETSCALE_SERVICE_TOKEN: "t",
        PLANETSCALE_ORG: "org",
      },
      calls: 2,
    },
  ];

  for (const c of cases) {
    it(`${c.name}: fails within the timeout instead of hanging`, async () => {
      const result = await provisionOrHang(c.adapter, c.env);
      assert.notEqual(result, HUNG, `provision() still pending after ${GUARD_MS} ms`);
      assert.equal((result as ProvisionResult).success, false);
      assert.deepEqual(requested, Array(c.calls).fill(15_000));
    });
  }
});
