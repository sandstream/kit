import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";

interface Worker {
  child: ChildProcess;
  done: Promise<void>;
  wait: (message: string) => Promise<void>;
  finish: () => Promise<void>;
  messages: string[];
}

export function auditFixture(t: TestContext, anchored = false) {
  const root = mkdtempSync(join(tmpdir(), "kit-audit-processes-"));
  const project = join(root, "project"),
    home = join(root, "home");
  mkdirSync(project);
  mkdirSync(home);
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith("KIT_")) delete env[name];
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, "config"),
    KIT_IDENTITY_DIR: join(home, "identity"),
    KIT_MEMORY_DIR: join(home, "memory"),
    KIT_MEMORY_DB: join(home, "memory.db"),
    KIT_AUDIT_ANCHOR_DIR: join(home, "anchors"),
    KIT_AUDIT_ANCHOR: anchored ? "1" : "0",
    KIT_KEYSTORE: "file",
    KIT_NO_UPDATE_CHECK: "1",
    KIT_NON_INTERACTIVE: "1",
  });
  const workers: Worker[] = [];
  t.after(async () => {
    for (const worker of workers) {
      if (worker.child.exitCode === null && worker.child.signalCode === null)
        worker.child.kill("SIGKILL");
      await worker.done;
    }
    rmSync(root, { recursive: true, force: true });
  });
  return { root, project, home, env, workers };
}

export function startAuditWorker(context: ReturnType<typeof auditFixture>, body: string): Worker {
  const source = `
    import assert from "node:assert/strict";
    import * as audit from ${JSON.stringify(new URL("./audit.js", import.meta.url).href)};
    import * as anchor from ${JSON.stringify(new URL("./audit-anchor.js", import.meta.url).href)};
    import { readFile, writeFile } from "node:fs/promises";
    import { join } from "node:path";
    const project = process.argv[1];
    const event = (operation) => ({ operation, environment: "test", success: true });
    const signal = (message) => process.send(message);
    const next = () => new Promise((resolve) => process.once("message", resolve));
    const ready = next(); signal("ready"); await ready;
    try { ${body} }
    catch (error) { console.error(error); process.exitCode = 1; }
    finally { if (process.connected) process.disconnect(); }
  `;
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", source, context.project],
    {
      env: context.env,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  let output = "",
    ended = false;
  const messages: string[] = [];
  child.stdout?.on("data", (chunk) => (output += String(chunk)));
  child.stderr?.on("data", (chunk) => (output += String(chunk)));
  child.on("error", (error) => (output += error.message));
  child.on("message", (message) => messages.push(String(message)));
  const done = new Promise<void>((resolve) =>
    child.once("close", () => {
      ended = true;
      resolve();
    }),
  );
  const worker: Worker = {
    child,
    done,
    messages,
    wait: async (message) => {
      const deadline = performance.now() + 30_000;
      while (!messages.includes(message)) {
        assert.ok(!ended, `Worker exited before ${message}: ${output}`);
        assert.ok(performance.now() < deadline, `Worker did not reach ${message}: ${output}`);
        await delay(10);
      }
    },
    finish: async () => {
      await done;
      assert.equal(child.exitCode, 0, output);
    },
  };
  context.workers.push(worker);
  return worker;
}

export async function runAuditWorkers(workers: Worker[]): Promise<void> {
  await Promise.all(workers.map((worker) => worker.wait("ready")));
  for (const worker of workers) worker.child.send("start");
  await Promise.all(workers.map((worker) => worker.finish()));
}

export function auditCli(context: ReturnType<typeof auditFixture>, args: string[]) {
  const compiled = fileURLToPath(new URL("./cli.js", import.meta.url));
  const cli = existsSync(compiled) ? compiled : fileURLToPath(new URL("./cli.ts", import.meta.url));
  return spawnSync(
    process.execPath,
    ["--import", import.meta.resolve("tsx"), cli, "audit", ...args],
    {
      cwd: context.project,
      env: context.env,
      encoding: "utf8",
      timeout: 30_000,
    },
  );
}
