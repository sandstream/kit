import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { runnerFixture } from "./monkey-test-runner.test-support.js";
import {
  eventually,
  processRunning,
  spawnMonkey,
} from "./monkey-test-runner-subprocess.test-support.js";
import {
  cleanScenario,
  scenarioPids,
  signalScenario,
  waitForExit,
  type SignalStage,
} from "./monkey-test-runner-signal.test-support.js";

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  for (const stage of ["env", "seed", "startup", "test"] satisfies SignalStage[]) {
    it(
      `MSG-03: ${signal} during ${stage} stops owned process trees`,
      { skip: process.platform === "win32" },
      async () => {
        const root = await runnerFixture();
        const scenario = signalScenario(root, stage);
        const run = spawnMonkey(root, scenario.args);
        try {
          assert.equal(
            await eventually(() => scenario.names.every((name) => existsSync(join(root, name)))),
            true,
            run.output().stderr,
          );
          const pids = scenarioPids(root, scenario.names);
          assert.equal(run.child.kill(signal), true);
          assert.equal(await waitForExit(run), true, "runner did not exit after signal");
          const exit = await run.exited;
          assert.ok(
            exit.signal === signal || exit.code === (signal === "SIGINT" ? 130 : 143),
            JSON.stringify(exit),
          );
          assert.equal(
            await eventually(() => pids.every((pid) => !processRunning(pid)), 2_000),
            true,
            `orphan processes: ${pids.filter(processRunning).join(", ")}`,
          );
          if (stage === "env") assert.equal(existsSync(join(root, "seed.ran")), false);
          if (stage !== "test") assert.equal(existsSync(join(root, "test.ran")), false);
        } finally {
          await cleanScenario(run, root, scenario.names);
          rmSync(root, { recursive: true, force: true });
        }
      },
    );
  }
}
