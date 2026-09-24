import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { it } from "node:test";
import { markerCommand, runnerFixture, serverCommand } from "./monkey-test-runner.test-support.js";
import {
  cleanScenario,
  concurrentScenario,
  forkedServerCommands,
  scenarioPids,
  waitForExit,
} from "./monkey-test-runner-signal.test-support.js";
import {
  eventually,
  processRunning,
  runMonkey,
  spawnRunnerScript,
} from "./monkey-test-runner-subprocess.test-support.js";
import { runMonkeyTest } from "./monkey-test-runner.js";
import type { MonkeyRunResult } from "./monkey-test-contract.js";

it(
  "MSG-03: concurrent runs finish all cleanup and preserve a borrowed server",
  { skip: process.platform === "win32" },
  async () => {
    const root = await runnerFixture();
    let requested = false;
    const server = createServer(() => {
      requested = true;
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const scenario = concurrentScenario(root, `http://127.0.0.1:${address.port}`);
    const run = spawnRunnerScript(root, scenario.script);
    try {
      assert.equal(
        await eventually(
          () => requested && scenario.names.every((name) => existsSync(join(root, name))),
        ),
        true,
        run.output().stderr,
      );
      const pids = scenarioPids(root, scenario.names);
      assert.equal(run.child.kill("SIGTERM"), true);
      assert.equal(await waitForExit(run), true);
      assert.equal((await run.exited).code, 143);
      assert.equal(
        await eventually(() => pids.every((pid) => !processRunning(pid)), 2_000),
        true,
        "concurrent run left orphan processes",
      );
      assert.equal(server.listening, true, "borrowed server was stopped");
    } finally {
      await cleanScenario(run, root, scenario.names);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it("MSG-03: failed prerequisites restore signal listeners on repeated calls", async () => {
  const root = await runnerFixture();
  const original = [process.listeners("SIGINT"), process.listeners("SIGTERM")];
  try {
    rmSync(join(root, "tests/monkey/monkey.spec.ts"));
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await runMonkeyTest(root);
      assert.equal(result.ok, false);
      assert.deepEqual([process.listeners("SIGINT"), process.listeners("SIGTERM")], original);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const outcome of ["missing evidence", "exception"]) {
  it(`MSG-03: ${outcome} stops server and restores listeners`, async () => {
    const root = await runnerFixture();
    const original = [process.listeners("SIGINT"), process.listeners("SIGTERM")];
    try {
      if (outcome === "exception") mkdirSync(join(root, ".kit/monkey-test/playwright-report.json"));
      const run = runMonkeyTest(root, {
        skipSecurity: true,
        skipSeed: true,
        expectedReason: "Synthetic cleanup regression fixture",
        startCommand: serverCommand(root),
        testCommand: markerCommand(root, "test"),
      });
      if (outcome === "exception") await assert.rejects(run, { code: "ERR_FS_EISDIR" });
      else assert.equal((await run).ok, false);
      assert.equal(existsSync(join(root, "server.ran")), true);
      assert.equal(
        await eventually(() =>
          scenarioPids(root, ["server.pid"]).every((pid) => !processRunning(pid)),
        ),
        true,
      );
      assert.deepEqual([process.listeners("SIGINT"), process.listeners("SIGTERM")], original);
    } finally {
      for (const pid of scenarioPids(root, ["server.pid"])) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* Already stopped. */
        }
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
}

it(
  "MSG-03: server descendants remain available after leader exit until browser work finishes",
  { skip: process.platform === "win32" },
  async () => {
    const root = await runnerFixture();
    try {
      const commands = forkedServerCommands(root);
      const result = await runMonkey(root, [
        "--json",
        "--skip-seed",
        "--start-command",
        commands.startCommand,
        "--test-command",
        commands.testCommand,
      ]);
      assert.equal(result.code, 1, result.stderr);
      const report = JSON.parse(result.stdout) as MonkeyRunResult;
      assert.equal(
        existsSync(join(root, "test.ran")),
        true,
        "server descendant was stopped before browser work finished",
      );
      assert.ok(
        report.findings.some(
          (finding) => finding.title === "Playwright evidence missing or invalid",
        ),
      );
      const pids = scenarioPids(root, ["server.pid"]);
      assert.equal(pids.length, 1);
      assert.ok(
        pids.every((pid) => !processRunning(pid)),
        "server descendant survived final cleanup",
      );
    } finally {
      for (const pid of scenarioPids(root, ["server.pid"])) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* Already stopped. */
        }
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
);
