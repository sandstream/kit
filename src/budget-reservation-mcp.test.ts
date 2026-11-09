import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  budgetContents,
  governanceClient,
  governanceFixture,
  projectConfig,
  seedBudget,
} from "./governance-outcome.test-support.js";
import { getBudgetStatus } from "./budget.js";
import { reservationCli } from "./budget-reservation.test-support.js";

function childScripts(cwd: string) {
  const first = join(cwd, "reservation-first.cjs");
  const second = join(cwd, "reservation-second.cjs");
  const started = join(cwd, "first-started");
  const finished = join(cwd, "first-finished");
  const release = join(cwd, "release-first");
  const attempted = join(cwd, "second-started");
  writeFileSync(
    first,
    `
    const fs = require("node:fs");
    process.on("exit", () => fs.writeFileSync(${JSON.stringify(finished)}, "stopped"));
    fs.writeFileSync(${JSON.stringify(started)}, String(process.pid));
    const deadline = setTimeout(() => process.exit(7), 15000);
    const timer = setInterval(() => {
      if (fs.existsSync(${JSON.stringify(release)})) {
        clearInterval(timer);
        clearTimeout(deadline);
      }
    }, 10);
  `,
  );
  writeFileSync(
    second,
    `require("node:fs").writeFileSync(${JSON.stringify(attempted)}, "unexpected");`,
  );
  return { first, second, started, finished, release, attempted };
}

async function waitForStart(marker: string, completed: () => boolean): Promise<void> {
  const deadline = Date.now() + 10000;
  while (!existsSync(marker)) {
    assert.ok(!completed(), "The first MCP request ended before its child started");
    assert.ok(Date.now() < deadline, "The first MCP child did not start");
    await delay(10);
  }
}

function killMarkedChild(marker: string): void {
  if (!existsSync(marker)) return;
  const pid = Number(readFileSync(marker, "utf8"));
  assert.ok(Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid);
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function awaitChildExit(marker: string): Promise<void> {
  if (!existsSync(marker)) return;
  const pid = Number(readFileSync(marker, "utf8"));
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    assert.ok(Date.now() < deadline, "The owned MCP child did not exit during cleanup");
    await delay(10);
  }
}

async function releaseFirst<T>(
  scripts: ReturnType<typeof childScripts>,
  pending: Promise<T>,
): Promise<T> {
  writeFileSync(scripts.release, "release");
  // The marker normally releases the child. This fallback also covers a failed request.
  const timer = setTimeout(() => {
    if (!existsSync(scripts.finished)) killMarkedChild(scripts.started);
  }, 2000);
  try {
    return await pending;
  } catch (error) {
    if (!existsSync(scripts.finished)) killMarkedChild(scripts.started);
    throw error;
  } finally {
    clearTimeout(timer);
    await awaitChildExit(scripts.started);
  }
}

async function denySecond(
  transport: "MCP" | "CLI",
  client: Awaited<ReturnType<typeof governanceClient>>,
  target: string,
  script: string,
): Promise<void> {
  if (transport === "CLI") {
    const result = await reservationCli(target, ["run", "--", process.execPath, script]);
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.code, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /Operation budget exceeded: 1\/1 operations this hour/);
  } else {
    const result = await client.callTool({
      name: "kit_run",
      arguments: { cwd: target, command: `"${process.execPath}" "${script}"` },
    });
    assert.equal(result.isError, true, JSON.stringify(result));
    assert.match(
      JSON.stringify(result.content),
      /Operation budget exceeded: 1\/1 operations this hour/,
    );
  }
}

for (const transport of ["MCP", "CLI"] as const) {
  it(
    `reserves the only allowance before a competing ${transport} request can start its child`,
    { timeout: 30000 },
    async (t) => {
      const { host, target } = governanceFixture(t);
      writeFileSync(
        join(target, ".kit.toml"),
        projectConfig.replace("max_operations_per_hour = 2", "max_operations_per_hour = 1"),
      );
      const hostBefore = seedBudget(host, 31, 2);
      const scripts = childScripts(target);
      const client = await governanceClient(t);
      let completed = false;
      const pending = client
        .callTool(
          {
            name: "kit_run",
            arguments: { cwd: "../target", command: `"${process.execPath}" "${scripts.first}"` },
          },
          undefined,
          { timeout: 20000 },
        )
        .finally(() => {
          completed = true;
        });
      // Attach a rejection handler immediately; finally below still observes the original error.
      void pending.catch(() => undefined);
      let firstResult: Awaited<typeof pending>;
      let booked: string | undefined;
      try {
        await waitForStart(scripts.started, () => completed);
        assert.equal(completed, false);
        assert.equal(existsSync(scripts.finished), false);
        booked = budgetContents(target);
        assert.equal(JSON.parse(booked!).operations_this_hour, 1);
        assert.equal(JSON.parse(booked!).tokens_today, 0);
        assert.equal(budgetContents(host), hostBefore);
        await denySecond(transport, client, target, scripts.second);
        assert.equal(existsSync(scripts.attempted), false);
        assert.equal(completed, false, "Denial must precede the first operation's release");
        assert.equal(existsSync(scripts.finished), false);
        assert.equal(budgetContents(target), booked);
        assert.equal(budgetContents(host), hostBefore);
      } finally {
        firstResult = await releaseFirst(scripts, pending);
      }
      assert.notEqual(firstResult.isError, true, JSON.stringify(firstResult));
      assert.match(JSON.stringify(firstResult.content), /Exit code: 0/);
      assert.equal(readFileSync(scripts.finished, "utf8"), "stopped");
      assert.equal(existsSync(scripts.attempted), false);
      const finalUsage = await getBudgetStatus({ enabled: true }, { cwd: target });
      assert.equal(finalUsage.operations_used, 1);
      assert.equal(finalUsage.tokens_used, 0);
      assert.equal(budgetContents(host), hostBefore);
    },
  );
}
