import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { readAuditLog, verifyAuditChain } from "./audit.js";
import { createCliContractFixture } from "./cli-contract.test-support.js";

function runGuard(
  fixture: ReturnType<typeof createCliContractFixture>,
  body: string,
  api: "withGovernance" | "runGoverned" | "checkGovernance" = "withGovernance",
) {
  const source = import.meta.url.endsWith(".ts");
  const module = new URL(
    source ? "./governance-middleware.ts" : "./governance-middleware.js",
    import.meta.url,
  );
  const loader = source ? ["--import", import.meta.resolve("tsx")] : [];
  const script = `
    import { withGovernance, runGoverned, checkGovernance } from ${JSON.stringify(module.href)};
    import { writeFile } from 'node:fs/promises';
    const config = { governance: {
      enabled: true, environment: 'dev', agent: { id: 'test-agent' },
      secrets: { check_expiration: false },
      revocation: { enabled: true, revocation_endpoint: ${JSON.stringify(`data:application/json,${encodeURIComponent(body)}`)} }
    } };
    try {
      const context = {operation: 'write-proof', operationType: 'write'};
      const result = ${
        api === "checkGovernance"
          ? "await checkGovernance(config, context)"
          : `await ${api}(config, context, () => writeFile('effect.txt', 'written'))`
      };
      console.log(JSON.stringify(result) ?? 'allowed');
    } catch (error) { console.log(error.message); }
    console.log('caller-alive');
  `;
  return spawnSync(process.execPath, [...loader, "--input-type=module", "-e", script], {
    cwd: fixture.cwd,
    env: fixture.env,
    encoding: "utf8",
    timeout: 10_000,
  });
}

it("revoked access rejects the operation and records the denial before returning to its caller", async (t) => {
  const fixture = createCliContractFixture();
  t.after(() => fixture.cleanup());
  const result = runGuard(fixture, '{"revoked":true}');
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Access revoked\ncaller-alive/);
  assert.equal(existsSync(join(fixture.cwd, "effect.txt")), false);
  assert.equal(existsSync(join(fixture.cwd, ".kit-budget.json")), false);
  const log = join(fixture.cwd, ".kit-audit.jsonl");
  const events = await readAuditLog(log);
  assert.equal(events.length, 1);
  assert.equal(events[0].operation, "write-proof");
  assert.equal(events[0].success, false);
  assert.equal(events[0].error, "Access revoked");
  assert.equal(verifyAuditChain(readFileSync(log, "utf8")).ok, true);
});

for (const api of ["withGovernance", "runGoverned", "checkGovernance"] as const) {
  it(`${api} denies an unverified response without claiming confirmed revocation`, async (t) => {
    const fixture = createCliContractFixture();
    t.after(() => fixture.cleanup());
    const result = runGuard(fixture, "{}", api);
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Revocation status could not be verified/);
    assert.match(result.stdout, /caller-alive/);
    assert.doesNotMatch(result.stdout, /Access (has been )?revoked|allowed.*true|ok.*true/);
    assert.equal(existsSync(join(fixture.cwd, "effect.txt")), false);
    assert.equal(existsSync(join(fixture.cwd, ".kit-budget.json")), false);
    if (api !== "checkGovernance") {
      const events = await readAuditLog(join(fixture.cwd, ".kit-audit.jsonl"));
      assert.equal(events.length, 1);
      assert.equal(events[0].success, false);
      assert.equal(events[0].error, "Revocation status could not be verified");
    }
  });
}
