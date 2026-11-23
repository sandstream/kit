import assert from "node:assert/strict";
import { execFileSync, fork } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { setTimeout as pause } from "node:timers/promises";
import { readLaunchScripts, runtimeProfile, RUN_ENV } from "./launch-profile.js";
import type { SupervisorRequest } from "./launch-supervisor.js";
import { snapshotFixture } from "./snapshot.test-support.js";

function state(pid: number): string | undefined {
  try {
    return execFileSync("/bin/ps", ["-o", "state=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

function syntheticArgs(root: string, marker: string): string[] {
  const runtime = realpathSync(process.execPath);
  const [metadata, profile] = runtimeProfile({ input: root, output: root, runtime });
  const script = [
    'import {renameSync,writeFileSync} from "node:fs";',
    'const marker=process.argv[1];writeFileSync(marker+".tmp",String(process.pid));',
    'renameSync(marker+".tmp",marker);process.kill(process.pid,"SIGSTOP");',
    "setTimeout(() => {}, 20000);",
  ].join("\n");
  return [
    "-D",
    "KIT_RUNTIME=" + runtime,
    "-D",
    "KIT_INPUT=" + root,
    "-D",
    "KIT_OUTPUT=" + root,
    ...metadata,
    "-p",
    profile,
    runtime,
    "--input-type=module",
    "-e",
    script,
    marker,
  ];
}

it(
  "reaps a suspended sandbox process when the Kit parent dies",
  {
    skip: process.platform !== "darwin" || process.arch !== "arm64",
  },
  async () => {
    const f = snapshotFixture();
    const root = realpathSync(f.root);
    const marker = join(root, "started");
    const manager = join(root, "manager.mjs");
    let child: ReturnType<typeof fork> | undefined;
    let pid: number | undefined;
    let supervisorPid: number | undefined;
    try {
      const request = {
        args: syntheticArgs(root, marker),
        env: RUN_ENV,
        deadlineMs: 20_000,
      } satisfies Omit<SupervisorRequest, "parent">;
      writeFileSync(
        manager,
        [
          'import {spawn} from "node:child_process";',
          'const controller=spawn(process.execPath, ["--input-type=module","-e",' +
            JSON.stringify(readLaunchScripts().supervisor) +
            ',"--",JSON.stringify({...' +
            JSON.stringify(request) +
            ',parent:process.pid})],{stdio:"ignore",env:' +
            JSON.stringify(RUN_ENV) +
            "});",
          "process.send(controller.pid);setTimeout(() => {}, 20000);",
        ].join("\n"),
      );
      child = fork(manager, [], {
        cwd: root,
        execArgv: [],
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      const closed = once(child, "exit");
      const limit = AbortSignal.timeout(6000);
      [supervisorPid] = await once(child, "message", { signal: limit });
      while (!existsSync(marker)) await pause(20, undefined, { signal: limit });
      pid = Number(readFileSync(marker, "utf8"));
      assert.ok(Number.isInteger(pid) && pid > 0);
      while (!state(pid)?.startsWith("T")) await pause(20, undefined, { signal: limit });
      child.kill("SIGKILL");
      await closed;
      while (state(pid)) await pause(20, undefined, { signal: limit });
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        const closed = once(child, "exit");
        child.kill("SIGKILL");
        await closed;
      }
      if (pid && state(pid)) process.kill(pid, "SIGKILL");
      if (supervisorPid) {
        const limit = AbortSignal.timeout(3000);
        try {
          while (state(supervisorPid)) await pause(20, undefined, { signal: limit });
        } finally {
          if (state(supervisorPid)) process.kill(supervisorPid, "SIGKILL");
        }
      }
      f.cleanup();
    }
  },
);
