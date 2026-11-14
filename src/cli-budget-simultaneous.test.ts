import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readAuditLog } from "./audit.js";
import { createCliContractFixture } from "./cli-contract.test-support.js";
import { projectConfig, seedBudget } from "./governance-outcome.test-support.js";

const source = import.meta.url.endsWith(".ts");
const cli = fileURLToPath(new URL(source ? "./cli.ts" : "./cli.js", import.meta.url));
const loader = source ? ["--import", import.meta.resolve("tsx")] : [];

function admissionBarrier(root: string, cwd: string): { preload: string; release: string } {
  const preload = join(root, "budget-admission-barrier.mjs");
  const release = join(root, "release-admission");
  const lock = join(realpathSync(cwd), ".kit-budget-lock.sqlite");
  // Pause before the real validation open. Governance has passed its preliminary check,
  // but neither process can read or change usage inside the SQLite transaction yet.
  writeFileSync(
    preload,
    `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { performance } from "node:perf_hooks";
const originalOpen = fs.openSync;
let arrived = false;
fs.openSync = function (...args) {
  if (!arrived && args[0] === ${JSON.stringify(lock)}) {
    arrived = true;
    const ready = process.env.KIT_TEST_BUDGET_READY; // renamed in whole: the test polls existsSync
    fs.writeFileSync(ready + ".tmp", String(process.pid)); fs.renameSync(ready + ".tmp", ready);
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    const deadline = performance.now() + 10000;
    while (!fs.existsSync(${JSON.stringify(release)})) {
      if (performance.now() >= deadline) throw new Error("Admission barrier was not released");
      Atomics.wait(sleeper, 0, 0, 10);
    }
  }
  return Reflect.apply(originalOpen, fs, args);
};
syncBuiltinESMExports();
`,
  );
  return { preload, release };
}

function startContender(
  fixture: ReturnType<typeof createCliContractFixture>,
  preload: string,
  name: string,
) {
  const ready = join(fixture.root, `${name}-ready`);
  const marker = join(fixture.cwd, `${name}-executed`);
  const script = `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed");`;
  const child = spawn(
    process.execPath,
    [
      ...loader,
      "--import",
      pathToFileURL(preload).href,
      cli,
      "run",
      "--",
      process.execPath,
      "-e",
      script,
    ],
    {
      cwd: fixture.cwd,
      env: { ...fixture.env, KIT_TEST_BUDGET_READY: ready },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15000,
    },
  );
  let stdout = "";
  let stderr = "";
  let error: Error | undefined;
  child.stdout.on("data", (data) => (stdout += String(data)));
  child.stderr.on("data", (data) => (stderr += String(data)));
  child.once("error", (cause) => (error = cause));
  const closed = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
    error?: Error;
  }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr, error }));
  });
  return { child, closed, ready, marker, diagnostics: () => stdout + stderr };
}

async function stopContender(contender: ReturnType<typeof startContender>): Promise<void> {
  if (contender.child.exitCode !== null || contender.child.signalCode !== null) {
    await contender.closed;
    return;
  }
  contender.child.kill("SIGTERM");
  // A process paused in the synchronous preload cannot run its signal handler.
  const force = setTimeout(() => contender.child.kill("SIGKILL"), 2000);
  try {
    await contender.closed;
  } finally {
    clearTimeout(force);
  }
}

it(
  "admits only one CLI contender when both reach the budget lock before admission",
  {
    timeout: 30000,
  },
  async (t) => {
    const fixture = createCliContractFixture(
      projectConfig.replace("max_operations_per_hour = 2", "max_operations_per_hour = 1"),
    );
    const contenders: ReturnType<typeof startContender>[] = [];
    t.after(async () => {
      try {
        await Promise.all(contenders.map(stopContender));
      } finally {
        fixture.cleanup();
      }
    });
    const before = seedBudget(fixture.cwd, 0, 0);
    const state = join(fixture.cwd, ".kit-budget.json");
    const barrier = admissionBarrier(fixture.root, fixture.cwd);
    for (const name of ["first", "second"]) {
      contenders.push(startContender(fixture, barrier.preload, name));
    }
    const deadline = performance.now() + 10000;
    while (!contenders.every(({ ready }) => existsSync(ready))) {
      for (const contender of contenders) {
        assert.equal(contender.child.exitCode, null, contender.diagnostics());
        assert.equal(contender.child.signalCode, null, contender.diagnostics());
      }
      assert.ok(
        performance.now() < deadline,
        "Both CLI contenders must reach the admission barrier",
      );
      await delay(10);
    }
    for (const contender of contenders) {
      assert.equal(Number(readFileSync(contender.ready, "utf8")), contender.child.pid);
      assert.equal(existsSync(contender.marker), false);
    }
    assert.equal(readFileSync(state, "utf8"), before);
    writeFileSync(barrier.release, "release both");
    const results = await Promise.all(contenders.map(({ closed }) => closed));
    for (const result of results) {
      assert.ifError(result.error);
      assert.equal(result.signal, null, result.stdout + result.stderr);
    }
    assert.equal(
      contenders.filter(({ marker }) => existsSync(marker)).length,
      1,
      "Only one admitted child may execute with allowance one",
    );
    assert.deepEqual(results.map(({ code }) => code).sort(), [0, 1]);
    const denied = results.find(({ code }) => code === 1)!;
    assert.match(denied.stderr, /Operation budget exceeded: 1\/1 operations this hour/);
    const status = fixture.run(["whoami", "--json"]);
    assert.equal(status.status, 0, status.stdout + status.stderr);
    assert.deepEqual(JSON.parse(status.stdout).budget, {
      tokens_used: 0,
      tokens_limit: 100,
      operations_used: 1,
      operations_limit: 1,
    });
    const events = await readAuditLog(join(fixture.cwd, ".kit-audit.jsonl"));
    assert.equal(events.length, 2);
    assert.equal(events.filter((event) => event.success).length, 1);
    const refusal = events.find((event) => !event.success)!;
    assert.equal(refusal.operation, "run");
    assert.equal(refusal.error, "Operation budget exceeded: 1/1 operations this hour");
  },
);
