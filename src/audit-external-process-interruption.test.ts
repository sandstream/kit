import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { runExternalProtocol } from "./audit-external-process.js";
import { assertStopped, fixture, trackedPid } from "./audit-external-process.test-support.js";

async function waitForFixtureFiles(paths: string[], host: ChildProcess): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (paths.some((path) => !existsSync(path))) {
    assert.equal(host.exitCode, null, "host must stay alive until the command is ready");
    assert.equal(host.signalCode, null, "host must not exit on a signal before the test");
    assert.ok(Date.now() < deadline, "host and descendants must become ready");
    await delay(10);
  }
}

async function within<T>(pending: Promise<T>, milliseconds: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("fixture exceeded its deadline")), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function interruptCommand(f: ReturnType<typeof fixture>, name: string) {
  const commandPid = join(f.root, `${name}-command.pid`);
  const descendantPid = join(f.root, `${name}-descendant.pid`);
  const heartbeat = join(f.root, `${name}-heartbeat`);
  const descendant = `const fs = require('node:fs');
    process.on('SIGINT', () => {}); process.on('SIGTERM', () => {});
    fs.writeFileSync(${JSON.stringify(descendantPid)}, String(process.pid));
    fs.writeFileSync(${JSON.stringify(heartbeat)}, 'ready');
    setInterval(() => fs.appendFileSync(${JSON.stringify(heartbeat)}, '.'), 10);
    setTimeout(() => process.exit(0), 12000);
  `;
  const command = f.command(`const fs = require('node:fs');
    process.on('SIGINT', () => {}); process.on('SIGTERM', () => {}); process.stdin.resume();
    fs.writeFileSync(${JSON.stringify(commandPid)}, String(process.pid));
    require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {
      stdio: ['ignore', 1, 2],
    });
    setTimeout(() => process.exit(0), 12000);
  `);
  return { command, commandPid, descendantPid, heartbeat };
}

function startInterruptHost(f: ReturnType<typeof fixture>, source: string) {
  const adapter = new URL("./audit-external-process.js", import.meta.url).href;
  const host = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
    import { runExternalProtocol } from ${JSON.stringify(adapter)};
    import { writeFileSync } from 'node:fs';
    ${source}
  `,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  if (host.pid) writeFileSync(join(f.root, "host.pid"), String(host.pid));
  let stderr = "";
  host.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  host.stdout.resume();
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      host.once("error", reject);
      host.once("close", (code, signal) => resolve({ code, signal }));
    },
  );
  return { host, exited, diagnostics: () => stderr };
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  test(
    `host ${signal} stops its detached verifier tree before default host exit`,
    {
      skip:
        process.platform === "win32"
          ? "Windows process.kill cannot deliver catchable POSIX host signals"
          : false,
    },
    async (t) => {
      const f = fixture(t);
      const tree = interruptCommand(f, "verifier");
      const { host, exited, diagnostics } = startInterruptHost(
        f,
        `
      await runExternalProtocol(${JSON.stringify(tree.command)}, {}).catch(() => {});
    `,
      );
      await waitForFixtureFiles([tree.commandPid, tree.descendantPid, tree.heartbeat], host);
      const before = readFileSync(tree.heartbeat, "utf8");
      await delay(40);
      assert.notEqual(
        readFileSync(tree.heartbeat, "utf8"),
        before,
        "descendant must have real effects before interruption",
      );
      assert.equal(host.kill(signal), true);
      const outcome = await within(exited, 3_000);
      assert.equal(outcome.signal, signal, diagnostics());
      await assertStopped(trackedPid(tree.commandPid)());
      await assertStopped(trackedPid(tree.descendantPid)());
      const stopped = readFileSync(tree.heartbeat, "utf8");
      await delay(50);
      assert.equal(
        readFileSync(tree.heartbeat, "utf8"),
        stopped,
        "descendant effects must stop after host interruption",
      );
    },
  );

  test(
    `host ${signal} preserves existing listeners and stops concurrent verifier trees`,
    {
      skip:
        process.platform === "win32"
          ? "Windows process.kill cannot deliver catchable POSIX host signals"
          : false,
    },
    async (t) => {
      const f = fixture(t);
      const trees = [interruptCommand(f, "first"), interruptCommand(f, "second")];
      const resultPath = join(f.root, "host-result.json");
      const { host, exited, diagnostics } = startInterruptHost(
        f,
        `
      const received = [];
      const onInt = () => received.push('SIGINT:regular');
      const onTerm = () => received.push('SIGTERM:regular');
      const onceInt = () => received.push('SIGINT:once');
      const onceTerm = () => received.push('SIGTERM:once');
      process.on('SIGINT', onInt); process.on('SIGTERM', onTerm);
      process.once('SIGINT', onceInt); process.once('SIGTERM', onceTerm);
      const outcomes = await Promise.allSettled(${JSON.stringify(trees.map((tree) => tree.command))}
        .map(command => runExternalProtocol(command, {})));
      await new Promise(resolve => setImmediate(resolve));
      const result = {
        received,
        outcomes: outcomes.map(outcome => ({status: outcome.status, message: outcome.reason?.message})),
        retainedInt: process.listeners('SIGINT').includes(onInt),
        retainedTerm: process.listeners('SIGTERM').includes(onTerm),
        onceIntPresent: process.listeners('SIGINT').includes(onceInt),
        onceTermPresent: process.listeners('SIGTERM').includes(onceTerm),
        intListeners: process.listenerCount('SIGINT'),
        termListeners: process.listenerCount('SIGTERM'),
      };
      writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify(result));
    `,
      );
      await waitForFixtureFiles(
        trees.flatMap((tree) => [tree.commandPid, tree.descendantPid, tree.heartbeat]),
        host,
      );
      assert.equal(host.kill(signal), true);
      assert.deepEqual(await within(exited, 3_000), { code: 0, signal: null }, diagnostics());
      const result = JSON.parse(readFileSync(resultPath, "utf8"));
      assert.deepEqual(result.received, [`${signal}:regular`, `${signal}:once`]);
      assert.deepEqual(result.outcomes, [
        { status: "rejected", message: `External command interrupted by host ${signal}` },
        { status: "rejected", message: `External command interrupted by host ${signal}` },
      ]);
      assert.equal(result.retainedInt, true);
      assert.equal(result.retainedTerm, true);
      assert.equal(result.onceIntPresent, signal !== "SIGINT");
      assert.equal(result.onceTermPresent, signal !== "SIGTERM");
      assert.equal(result.intListeners, signal === "SIGINT" ? 1 : 2);
      assert.equal(result.termListeners, signal === "SIGTERM" ? 1 : 2);
      for (const tree of trees) {
        await assertStopped(trackedPid(tree.commandPid)());
        await assertStopped(trackedPid(tree.descendantPid)());
        const stopped = readFileSync(tree.heartbeat, "utf8");
        await delay(40);
        assert.equal(readFileSync(tree.heartbeat, "utf8"), stopped);
      }
    },
  );
}

test("restores host listener state after repeated successful and failed calls", async (t) => {
  const f = fixture(t);
  const onInt = (): void => {};
  const onTerm = (): void => {};
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  t.after(() => {
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
  });
  const intListeners = process.rawListeners("SIGINT");
  const termListeners = process.rawListeners("SIGTERM");
  const echo = f.command("process.stdin.pipe(process.stdout);");
  const fail = f.command("process.stdin.resume(); process.stdin.on('end', () => process.exit(7));");
  const hang = f.command("process.stdin.resume(); setInterval(() => {}, 1000);");
  for (let iteration = 0; iteration < 3; iteration++) {
    const outcomes = await Promise.allSettled([
      runExternalProtocol(echo, { iteration }),
      runExternalProtocol(fail, {}),
      runExternalProtocol(hang, {}, { timeoutMs: 150 }),
    ]);
    assert.deepEqual(
      outcomes.map((outcome) => outcome.status),
      ["fulfilled", "rejected", "rejected"],
    );
    assert.deepEqual(process.rawListeners("SIGINT"), intListeners);
    assert.deepEqual(process.rawListeners("SIGTERM"), termListeners);
  }
});
