import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { it, type TestContext } from "node:test";
import { createCliContractFixture } from "./cli-contract.test-support.js";
import { executeCommand, type RunResult } from "./run.js";

async function within<T>(pending: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return !/^[ZX] /.test(stat.slice(stat.lastIndexOf(")") + 2));
    }
    return true;
  } catch (error) {
    if (["ESRCH", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
}

type RuntimeFixture = ReturnType<typeof createCliContractFixture>;
// "orphan" is "exit" with a detached descendant. Windows ends a descendant that is not
// detached when its parent exits (libuv puts it in a kill-on-close job), so only a
// detached one outlives the parent and keeps the output pipes open.
type TreeMode = "timeout" | "output" | "exit" | "escape" | "orphan";

function killRecordedProcess(path: string): void {
  if (!existsSync(path)) return;
  const pid = Number(readFileSync(path, "utf8"));
  if (!Number.isSafeInteger(pid) || pid <= 0 || !running(pid)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function assertRecordedProcessStopped(path: string): Promise<void> {
  if (!existsSync(path)) return;
  const pid = Number(readFileSync(path, "utf8"));
  for (let attempt = 0; attempt < 100 && running(pid); attempt++) await delay(20);
  assert.equal(running(pid), false, `fixture process ${pid} survived cleanup`);
}

function writeTreePrograms(fixture: RuntimeFixture, mode: TreeMode) {
  const rootPid = join(fixture.cwd, "root.pid");
  const leafPid = join(fixture.cwd, "leaf.pid");
  const stop = join(fixture.cwd, "stop");
  // Both processes watch the stop file, including before a late start. The hard
  // deadline also bounds their lifetime if the test runner itself is interrupted.
  const watchdog = `
    const fs = require('node:fs');
    const stop = ${JSON.stringify(stop)};
    if (fs.existsSync(stop)) process.exit(0);
    setInterval(() => { if (fs.existsSync(stop)) process.exit(0); }, 20);
    setTimeout(() => process.exit(0), 12000);
  `;
  const leaf = join(fixture.cwd, "leaf.cjs");
  writeFileSync(
    leaf,
    `${watchdog}\nfs.writeFileSync(${JSON.stringify(leafPid)}, String(process.pid));`,
  );
  const root = join(fixture.cwd, "root.cjs");
  writeFileSync(
    root,
    `${watchdog}
    fs.writeFileSync(${JSON.stringify(rootPid)}, String(process.pid));
    const child = require('node:child_process').spawn(process.execPath, [${JSON.stringify(leaf)}], {
      stdio: ['ignore', 1, 2], detached: ${mode === "escape" || mode === "orphan"},
    });
    child.on('error', () => process.exit(2));
    const ready = setInterval(() => {
      if (!fs.existsSync(${JSON.stringify(leafPid)})) return;
      clearInterval(ready);
      ${mode === "output" ? "fs.writeSync(1, 'x'.repeat(4096));" : ""}
      ${mode === "exit" || mode === "orphan" ? "process.exit(0);" : ""}
    }, 10);
  `,
  );
  return { root, rootPid, leafPid, stop };
}

async function cleanupTreeFixture(
  fixture: RuntimeFixture,
  tree: ReturnType<typeof writeTreePrograms>,
  pending: Promise<RunResult>,
): Promise<void> {
  try {
    writeFileSync(tree.stop, "stop");
    for (const path of [tree.leafPid, tree.rootPid]) killRecordedProcess(path);
    assert.ok(await within(pending, 2500), "runner did not settle after fixture cleanup");
    for (const path of [tree.leafPid, tree.rootPid]) await assertRecordedProcessStopped(path);
  } finally {
    fixture.cleanup();
  }
}

function treeFixture(t: TestContext, mode: TreeMode) {
  const fixture = createCliContractFixture();
  const tree = writeTreePrograms(fixture, mode);
  t.after(() => cleanupTreeFixture(fixture, tree, pending));
  const pending = executeCommand({
    commandArgs: [process.execPath, tree.root],
    cwd: fixture.cwd,
    inheritEnv: false,
    envOverrides: Object.fromEntries(
      Object.entries(fixture.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
    streamOutput: false,
    stdin: "ignore",
    timeoutMs: mode === "output" ? 5000 : 1000,
    maxOutputBytes: mode === "output" ? 64 : 4096,
  });
  return { pending, leafPid: tree.leafPid };
}

for (const mode of ["timeout", "output"] as const) {
  it(`stops descendants holding output pipes after the ${mode} limit`, async (t) => {
    const { pending, leafPid } = treeFixture(t, mode);
    const result = await within(pending, 3500);
    assert.ok(existsSync(leafPid), "the descendant must start before the limit");
    assert.ok(result, "the command must settle without waiting for the descendant's own deadline");
    assert.equal(result.exitCode, 124);
    assert.equal(mode === "timeout" ? result.timedOut : result.truncated, true);
    const pid = Number(readFileSync(leafPid, "utf8"));
    for (let attempt = 0; attempt < 50 && running(pid); attempt++) await delay(20);
    assert.equal(running(pid), false, "the descendant must stop before the result is accepted");
  });
}

it(
  "stops a POSIX process group after its leader exits",
  {
    skip:
      process.platform === "win32"
        ? "Windows taskkill requires a live parent; bounded pipe closure is tested separately"
        : false,
  },
  async (t) => {
    const { pending, leafPid } = treeFixture(t, "exit");
    const result = await within(pending, 3500);
    assert.ok(existsSync(leafPid));
    assert.ok(result, "a departed group leader must not disable the timeout");
    assert.equal(result.exitCode, 124);
    assert.equal(result.timedOut, true);
    const pid = Number(readFileSync(leafPid, "utf8"));
    for (let attempt = 0; attempt < 50 && running(pid); attempt++) await delay(20);
    assert.equal(running(pid), false);
  },
);

it("bounds pipe cleanup when descendants cannot be reached by the tree kill", async (t) => {
  // POSIX: the descendant deliberately starts a separate session. Windows:
  // taskkill cannot traverse a tree whose parent has already exited.
  const { pending, leafPid } = treeFixture(t, process.platform === "win32" ? "orphan" : "escape");
  const result = await within(pending, 3500);
  assert.ok(existsSync(leafPid));
  assert.ok(result, "inherited pipes must not defeat the execution deadline");
  assert.equal(result.exitCode, 124);
  assert.equal(result.timedOut, true);
  assert.match(result.stderr, /cleanup|pipes|descendant/i, "incomplete cleanup must be explicit");
});

function writeSignalTrees(fixture: RuntimeFixture, signal: "SIGINT" | "SIGTERM") {
  const pids = [0, 1, 2, 3].map((index) => join(fixture.cwd, `child-${index}.pid`));
  const marks = [0, 1, 2, 3].map((index) => join(fixture.cwd, `child-${index}.signal`));
  const processBody = (index: number) => `
  const fs = require('node:fs');
  process.on(${JSON.stringify(signal)}, () => fs.writeFileSync(${JSON.stringify(marks[index])}, 'received'));
  fs.writeFileSync(${JSON.stringify(pids[index])}, String(process.pid));
  setTimeout(() => process.exit(0), 12000);
`;
  const roots = [0, 2].map((index) => {
    const leaf = join(fixture.cwd, `leaf-${index}.cjs`);
    const root = join(fixture.cwd, `root-${index}.cjs`);
    writeFileSync(leaf, processBody(index + 1));
    writeFileSync(
      root,
      `${processBody(index)}
    require('node:child_process').spawn(process.execPath, [${JSON.stringify(leaf)}], {stdio: ['ignore', 1, 2]});
  `,
    );
    return root;
  });
  return { pids, marks, roots };
}

function signalFixture(t: TestContext, signal: "SIGINT" | "SIGTERM") {
  const fixture = createCliContractFixture();
  const { pids, marks, roots } = writeSignalTrees(fixture, signal);
  const source = import.meta.url.endsWith(".ts");
  const module = new URL(source ? "./run.ts" : "./run.js", import.meta.url).href;
  const parent = spawn(
    process.execPath,
    [
      ...(source ? ["--import", import.meta.resolve("tsx")] : []),
      "--input-type=module",
      "-e",
      `const {executeCommand} = await import(${JSON.stringify(module)});
   await Promise.all(${JSON.stringify(roots)}.map(root => executeCommand({commandArgs: [process.execPath, root],
     cwd: ${JSON.stringify(fixture.cwd)}, stdin: 'ignore', streamOutput: false, timeoutMs: 10000})));`,
    ],
    { cwd: fixture.cwd, env: fixture.env, stdio: "ignore" },
  );
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      parent.once("error", reject);
      parent.once("close", (code, signal) => resolve({ code, signal }));
    },
  );
  t.after(async () => {
    try {
      for (const path of [...pids].reverse()) killRecordedProcess(path);
      if (parent.exitCode === null && parent.signalCode === null) parent.kill("SIGKILL");
      assert.ok(await within(closed, 2500), "signal fixture parent survived cleanup");
    } finally {
      fixture.cleanup();
    }
  });
  return { parent, closed, pids, marks };
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  it(
    `cleans up descendants and preserves parent ${signal} termination`,
    {
      skip:
        process.platform === "win32"
          ? "Node cannot deliver catchable POSIX signals to a Windows process"
          : false,
    },
    async (t) => {
      const { parent, closed, pids, marks } = signalFixture(t, signal);
      for (let attempt = 0; attempt < 150 && !pids.every(existsSync); attempt++) await delay(20);
      assert.ok(pids.every(existsSync), "both process trees must start before interruption");
      parent.kill(signal);
      const result = await within(closed, 2500);
      assert.ok(result, "interruption cleanup must be bounded");
      assert.equal(result.signal, signal, "restore the parent's default signal exit after cleanup");
      for (const path of pids) {
        const pid = Number(readFileSync(path, "utf8"));
        for (let attempt = 0; attempt < 50 && running(pid); attempt++) await delay(20);
        assert.equal(running(pid), false, "interruption must not orphan a descendant");
      }
      assert.ok(marks.every(existsSync), "forward the original signal before forced termination");
    },
  );
}

it("preserves inherited stdin through a real parent pipe", async (t) => {
  const fixture = createCliContractFixture();
  const resultFile = join(fixture.cwd, "result.json");
  const source = import.meta.url.endsWith(".ts");
  const module = new URL(source ? "./run.ts" : "./run.js", import.meta.url).href;
  const script = "process.stdin.pipe(process.stdout)";
  const child = spawn(
    process.execPath,
    [
      ...(source ? ["--import", import.meta.resolve("tsx")] : []),
      "--input-type=module",
      "-e",
      `import {writeFileSync} from 'node:fs';
     const {executeCommand} = await import(${JSON.stringify(module)});
     const result = await executeCommand({commandArgs: [process.execPath, '-e', ${JSON.stringify(script)}],
       cwd: ${JSON.stringify(fixture.cwd)}, streamOutput: false, timeoutMs: 1000});
     writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify(result));`,
    ],
    { cwd: fixture.cwd, env: fixture.env, stdio: ["pipe", "ignore", "ignore"] },
  );
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    assert.ok((await within(closed, 2500)) !== undefined);
    fixture.cleanup();
  });
  child.stdin!.end("inherited \u00e5\u00e4\u00f6 😀\n");
  assert.equal(await within(closed, 2500), 0);
  const result = JSON.parse(readFileSync(resultFile, "utf8")) as RunResult;
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "inherited \u00e5\u00e4\u00f6 😀\n");
});

it("removes its parent signal listeners after success and spawn failure", async (t) => {
  const fixture = createCliContractFixture();
  t.after(() => fixture.cleanup());
  const before = [process.listeners("SIGINT"), process.listeners("SIGTERM")];
  for (const commandArgs of [
    [process.execPath, "-e", "process.exit(0)"],
    ["kit-missing-runtime-fixture"],
  ]) {
    await executeCommand({
      commandArgs,
      cwd: fixture.cwd,
      streamOutput: false,
      stdin: "ignore",
      timeoutMs: 1000,
    });
    assert.deepEqual([process.listeners("SIGINT"), process.listeners("SIGTERM")], before);
  }
});

it(
  "refuses a new command after the parent shutdown snapshot",
  {
    skip:
      process.platform === "win32"
        ? "Self-signals do not invoke POSIX signal handlers on Windows"
        : false,
  },
  async (t) => {
    const fixture = createCliContractFixture();
    const pidFile = join(fixture.cwd, "active.pid");
    const marker = join(fixture.cwd, "late-child-ran");
    const report = join(fixture.cwd, "report.json");
    const source = import.meta.url.endsWith(".ts");
    const module = new URL(source ? "./run.ts" : "./run.js", import.meta.url).href;
    const code = `
    import {writeFileSync, existsSync} from 'node:fs';
    import {setTimeout as delay} from 'node:timers/promises';
    const {executeCommand} = await import(${JSON.stringify(module)});
    const options = {cwd: ${JSON.stringify(fixture.cwd)}, stdin: 'ignore', streamOutput: false, timeoutMs: 5000};
    let late;
    process.on('SIGINT', () => {
      late = executeCommand({...options, commandArgs: [process.execPath, '-e',
        ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`)}]})
        .then(() => 'unexpected success', error => error.message);
    });
    const active = executeCommand({...options, commandArgs: [process.execPath, '-e',
      ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 5000)`)}]});
    for (let i = 0; i < 150 && !existsSync(${JSON.stringify(pidFile)}); i++) await delay(20);
    if (!existsSync(${JSON.stringify(pidFile)})) throw new Error('active child did not start');
    process.kill(process.pid, 'SIGINT');
    const result = await active;
    writeFileSync(${JSON.stringify(report)}, JSON.stringify({late: await late, code: result.exitCode}));
  `;
    const child = spawn(
      process.execPath,
      [
        ...(source ? ["--import", import.meta.resolve("tsx")] : []),
        "--input-type=module",
        "-e",
        code,
      ],
      { cwd: fixture.cwd, env: fixture.env, stdio: "ignore" },
    );
    const closed = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    t.after(async () => {
      try {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        assert.ok((await within(closed, 2500)) !== undefined);
        if (existsSync(pidFile)) {
          const pid = Number(readFileSync(pidFile, "utf8"));
          if (running(pid)) process.kill(pid, "SIGKILL");
        }
      } finally {
        fixture.cleanup();
      }
    });
    assert.equal(await within(closed, 4000), 0);
    const result = JSON.parse(readFileSync(report, "utf8"));
    assert.match(result.late, /Cannot start a command during SIGINT cleanup/);
    assert.equal(result.code, 130);
    assert.equal(existsSync(marker), false);
  },
);
