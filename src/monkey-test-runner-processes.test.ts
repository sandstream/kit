import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { it } from "node:test";
import { runShell, stopProcess } from "./monkey-test-process.js";
import { MonkeyProcessScope } from "./monkey-test-runner-processes.js";
import { fixtureEnvironment, runnerFixture } from "./monkey-test-runner.test-support.js";
import { completedStageCommand, scenarioPids } from "./monkey-test-runner-signal.test-support.js";
import { processRunning } from "./monkey-test-runner-subprocess.test-support.js";

function modelChild(): ChildProcess {
  const child = new ChildProcess();
  Object.defineProperty(child, "pid", { value: 9_000_001 });
  return child;
}

function missingGroup(): Error {
  return Object.assign(new Error("synthetic extinct process group"), { code: "ESRCH" });
}

it(
  "MSG-03: run cleanup never signals a retired PGID after reuse",
  { skip: process.platform === "win32" },
  async (t) => {
    const child = modelChild();
    let groupRunning = false;
    const signals: (string | number)[] = [];
    t.mock.method(process, "kill", (pid: number, signal: string | number = "SIGTERM") => {
      assert.equal(pid, -child.pid!);
      if (!groupRunning) throw missingGroup();
      if (signal !== 0) {
        signals.push(signal);
        groupRunning = false;
      }
      return true;
    });
    const scope = new MonkeyProcessScope();
    try {
      scope.add(child);
      Object.defineProperty(child, "exitCode", { value: 0 });
      child.emit("exit", 0, null);
      child.emit("close", 0, null);
      await new Promise<void>((resolve) => setImmediate(resolve));
      groupRunning = true;
      await scope.close();
      assert.deepEqual(signals, [], "cleanup signalled the unrelated replacement group");
      assert.equal(groupRunning, true, "unrelated replacement group was terminated");
    } finally {
      await scope.close();
    }
  },
);

it(
  "MSG-03: observed group extinction is final for a stop operation",
  { skip: process.platform === "win32" },
  async (t) => {
    const child = modelChild();
    let termSent = false;
    let extinctionObserved = false;
    const signals: (string | number)[] = [];
    t.mock.method(process, "kill", (pid: number, signal: string | number = "SIGTERM") => {
      assert.equal(pid, -child.pid!);
      if (signal === 0 && termSent && !extinctionObserved) {
        extinctionObserved = true;
        throw missingGroup();
      }
      if (signal !== 0) {
        signals.push(signal);
        termSent = true;
      }
      return true;
    });
    assert.equal(await stopProcess(child), true, "extinct group was probed again after PGID reuse");
    assert.deepEqual(signals, ["SIGTERM"], "stop operation signalled a recycled PGID");
  },
);

for (const inheritOutput of [false, true]) {
  it(
    `MSG-03: completed stage cleans descendants with ${inheritOutput ? "inherited" : "closed"} output pipes before returning`,
    { skip: process.platform === "win32" },
    async () => {
      const root = await runnerFixture();
      const scope = new MonkeyProcessScope();
      try {
        const result = await runShell(completedStageCommand(root, inheritOutput), {
          cwd: root,
          env: fixtureEnvironment(root),
          timeoutMs: 2_000,
          processes: scope,
        });
        assert.equal(result.ok, true, "successful stage hung on descendant output or timed out");
        assert.equal(result.timedOut, false);
        const pids = scenarioPids(root, ["stage.child.pid"]);
        assert.equal(pids.length, 1, "descendant fixture did not start");
        assert.ok(
          pids.every((pid) => !processRunning(pid)),
          "stage returned with a live descendant",
        );
      } finally {
        await scope.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
}

it(
  "MSG-03: permission-denied probe is not proof of extinction",
  { skip: process.platform === "win32" },
  async (t) => {
    const child = modelChild();
    let firstProbe = true;
    let running = true;
    const signals: (string | number)[] = [];
    t.mock.method(process, "kill", (pid: number, signal: string | number = "SIGTERM") => {
      assert.equal(pid, -child.pid!);
      if (signal === 0 && firstProbe) {
        firstProbe = false;
        throw Object.assign(new Error("synthetic denied probe"), { code: "EPERM" });
      }
      if (!running) throw missingGroup();
      if (signal !== 0) {
        signals.push(signal);
        running = false;
      }
      return true;
    });
    const scope = new MonkeyProcessScope();
    try {
      scope.add(child);
      Object.defineProperty(child, "exitCode", { value: 0 });
      child.emit("exit", 0, null);
      await scope.close();
      assert.deepEqual(signals, ["SIGTERM"], "group was retired without confirmed extinction");
    } finally {
      await scope.close();
    }
  },
);
