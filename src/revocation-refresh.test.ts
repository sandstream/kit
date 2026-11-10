import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { it, type TestContext } from "node:test";
import { checkRevocationAccess, forceRevocationCheck } from "./revocation.js";
import { runGoverned } from "./governance-middleware.js";

async function overlap(t: TestContext, interval: number, failure = false) {
  const cwd = await mkdtemp(join(tmpdir(), "kit-revocation-refresh-"));
  let held: ServerResponse | undefined;
  let arrived!: () => void;
  const firstRequest = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  let requests = 0;
  const server = createServer((_req, res) => {
    if (++requests === 1) {
      held = res;
      arrived();
      return;
    }
    if (requests === 2 && failure) res.writeHead(503);
    res.end(JSON.stringify({ revoked: !failure && requests >= 3 }));
  });
  const pending: { older?: ReturnType<typeof forceRevocationCheck> } = {};
  t.after(async () => {
    held?.end('{"revoked":false}');
    await pending.older;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(cwd, { recursive: true, force: true });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const governance = {
    enabled: true,
    environment: "dev" as const,
    agent: { id: "overlap-agent" },
    audit: { enabled: false },
    secrets: { check_expiration: false },
    revocation: {
      enabled: true,
      check_interval: interval,
      revocation_endpoint: `http://127.0.0.1:${address.port}/agents/{agent_id}`,
    },
  };
  pending.older = forceRevocationCheck(governance, { cwd });
  await firstRequest;
  assert.equal((await forceRevocationCheck(governance, { cwd })).revoked, failure);
  await delay(30);
  return { cwd, governance, requests: () => requests };
}

for (const interval of [0, 0.01]) {
  it(`a completed refresh cannot authorize a write past interval ${interval} while an older request remains active`, async (t) => {
    const fixture = await overlap(t, interval);
    const outcome = await runGoverned(
      { governance: fixture.governance },
      {
        operation: "write-proof",
        operationType: "write",
        estimatedTokens: 7,
      },
      () => writeFile(join(fixture.cwd, "effect.txt"), "written"),
      { cwd: fixture.cwd },
    );
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, "Access revoked");
    assert.deepEqual(await readdir(fixture.cwd), []);
    assert.equal(fixture.requests(), 3);
  });
}

it("a completed failed refresh cannot delay recovery behind an older request", async (t) => {
  const fixture = await overlap(t, 300, true);
  assert.deepEqual(await checkRevocationAccess(fixture.governance, { cwd: fixture.cwd }), {
    allowed: true,
  });
  assert.equal(fixture.requests(), 3);
});
