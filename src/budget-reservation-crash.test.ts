import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import {
  budgetContents,
  governanceFixture,
  projectConfig,
  seedBudget,
} from "./governance-outcome.test-support.js";
import { reservationCli, reservationNode } from "./budget-reservation.test-support.js";

const budgetModule = new URL("./budget.js", import.meta.url).href;
const configModule = new URL("./config.js", import.meta.url).href;

function processScript(body: string): string[] {
  return [
    "--input-type=module",
    "--eval",
    `
    import { withBudget, getBudgetStatus } from ${JSON.stringify(budgetModule)};
    import { loadConfig } from ${JSON.stringify(configModule)};
    import { writeFileSync } from "node:fs";
    const config = await loadConfig(".kit.toml");
    ${body}
  `,
  ];
}

async function assertNextProcessDenied(target: string): Promise<void> {
  const denied = await reservationNode(
    target,
    processScript(`
    const before = await getBudgetStatus(config.governance, { cwd: process.cwd() });
    let reason;
    try {
      await withBudget(config.governance, 0, async () => {
        writeFileSync("second-started", "unexpected");
      }, { cwd: process.cwd() });
    } catch (error) { reason = error.message; }
    console.log(JSON.stringify({ before, reason }));
  `),
  );
  assert.equal(denied.signal, null, denied.stderr);
  assert.equal(denied.code, 0, denied.stderr);
  const result = JSON.parse(denied.stdout);
  assert.deepEqual(result.before, {
    tokens_used: 7,
    tokens_limit: 100,
    operations_used: 1,
    operations_limit: 1,
  });
  assert.equal(result.reason, "Operation budget exceeded: 1/1 operations this hour");
  assert.equal(existsSync(join(target, "second-started")), false);
}

it(
  "a self-killed process keeps its booked allowance and leaves no stale budget lock",
  {
    timeout: 30000,
    skip: process.platform === "win32" ? "Requires POSIX SIGKILL semantics" : false,
  },
  async (t) => {
    const { host, target } = governanceFixture(t);
    writeFileSync(
      join(target, ".kit.toml"),
      projectConfig.replace("max_operations_per_hour = 2", "max_operations_per_hour = 1"),
    );
    const hostBefore = seedBudget(host, 31, 2);
    const crash = await reservationNode(
      target,
      processScript(`
    await withBudget(config.governance, 7, async () => {
      writeFileSync("callback-started", String(process.pid));
      process.kill(process.pid, "SIGKILL");
      await new Promise(() => {});
    }, { cwd: process.cwd() });
  `),
    );
    assert.equal(crash.signal, "SIGKILL", crash.stdout + crash.stderr);
    assert.equal(crash.code, null);
    assert.ok(Number(readFileSync(join(target, "callback-started"), "utf8")) > 0);
    const booked = budgetContents(target);
    assert.equal(JSON.parse(booked!).operations_this_hour, 1);
    assert.equal(JSON.parse(booked!).tokens_today, 7);
    await assertNextProcessDenied(target);
    const status = await reservationCli(target, ["whoami", "--json"]);
    assert.equal(status.signal, null, status.stderr);
    assert.equal(status.code, 0, status.stdout + status.stderr);
    assert.deepEqual(JSON.parse(status.stdout).budget, {
      tokens_used: 7,
      tokens_limit: 100,
      operations_used: 1,
      operations_limit: 1,
    });
    assert.equal(budgetContents(target), booked, "Crash and inspection must not reset the ledger");
    assert.equal(budgetContents(host), hostBefore);
  },
);
