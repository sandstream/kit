import assert from "node:assert/strict";
import { createServer } from "node:http";
import { join } from "node:path";
import { it } from "node:test";
import { fixture } from "./pal-cli.test-support.js";
import type { PendingAction } from "./pal.js";

it("separate CLI processes retain local approval but raw restore requires explicit configuration", async (t) => {
  const environment = { KIT_MEMORY_PASSPHRASE: "Local-Approval-Transfer-4829" };
  const source = await fixture(t, "source-device", environment);
  const destination = await fixture(t, "destination-device", environment);
  let calls = 0;
  const server = createServer((_request, response) => {
    calls++;
    response.end();
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/approved`;
  await source.cli("add", "portable task, local check", "--verify-http", url);
  const [action] = JSON.parse(await source.cli("list", "--json")) as PendingAction[];
  assert.equal(JSON.parse(await source.cli("verify", "--json")).checked, 1);
  assert.equal(calls, 1);
  const blob = join(source.root, "history.enc");
  await source.memory("backup", blob);
  await destination.memory("restore", blob);
  const before = JSON.parse(await destination.cli("list", "--json", "--all", "--global"));
  await assert.rejects(destination.cli("verify", "--json"), (error: unknown) => {
    const failure = error as { code?: number; stdout?: string };
    assert.equal(failure.code, 1);
    const report = JSON.parse(failure.stdout ?? "");
    assert.equal(report.checked, 0);
    assert.equal(report.unverified[0]?.reason, "no-local-approval");
    return true;
  });
  assert.equal(calls, 1, "restore must not issue the source's request");
  assert.deepEqual(
    JSON.parse(await destination.cli("list", "--json", "--all", "--global")),
    before,
  );
  await destination.cli("configure", action.id, "--verify-http", url);
  await destination.cli("verify");
  assert.deepEqual(JSON.parse(await destination.cli("verify", "--json")).closed, [action.id]);
  assert.equal(calls, 3);
  assert.equal(
    (JSON.parse(await source.cli("list", "--json")) as PendingAction[])[0]?.id,
    action.id,
  );
});
