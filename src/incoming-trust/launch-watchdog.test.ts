import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { setTimeout as pause } from "node:timers/promises";
import { snapshotFixture } from "./snapshot.test-support.js";

it(
  "stops its own process when the trusted launcher dies",
  { skip: process.platform !== "darwin" },
  async () => {
    const f = snapshotFixture();
    const manager = join(f.root, "manager.mjs");
    const ready = join(f.root, "ready");
    let pid: number | undefined;
    let child: ReturnType<typeof fork> | undefined;
    try {
      const runner = [
        'import {Worker} from "node:worker_threads";',
        'import {once} from "node:events";',
        'import {renameSync,writeFileSync} from "node:fs";',
        "const worker = new Worker(new URL(process.argv[1]), {execArgv:[],workerData:{parent:process.ppid,delay:20000}});",
        'await once(worker, "message");',
        'writeFileSync(process.argv[2]+".tmp", String(process.pid));',
        'renameSync(process.argv[2]+".tmp",process.argv[2]);',
        "setTimeout(() => {}, 10000);",
      ].join("\n");
      writeFileSync(
        manager,
        [
          'import {spawn} from "node:child_process";',
          'spawn(process.execPath, ["--input-type=module","-e",' +
            JSON.stringify(runner) +
            "," +
            JSON.stringify(new URL("./launch-watchdog.js", import.meta.url).href) +
            ',process.argv[2]], {stdio:"ignore"});',
          "setTimeout(() => {}, 10000);",
        ].join("\n"),
      );
      child = fork(manager, [ready], {
        execArgv: [],
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      const completion = once(child, "exit");
      const limit = AbortSignal.timeout(5000);
      while (!existsSync(ready)) await pause(20, undefined, { signal: limit });
      pid = Number(readFileSync(ready, "utf8"));
      assert.ok(Number.isInteger(pid) && pid > 0);
      process.kill(pid, 0);
      child.kill("SIGKILL");
      await completion;
      while (alive(pid)) await pause(20, undefined, { signal: limit });
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        const closed = once(child, "exit");
        child.kill("SIGKILL");
        await closed;
      }
      if (pid && alive(pid)) process.kill(pid, "SIGKILL");
      f.cleanup();
    }
  },
);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    return false;
  }
}
