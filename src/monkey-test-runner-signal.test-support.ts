/** Synthetic process trees for POSIX cleanup regressions. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureCommand, markerCommand, serverCommand } from "./monkey-test-runner.test-support.js";
import {
  eventually,
  runnerEntry,
  spawnMonkey,
} from "./monkey-test-runner-subprocess.test-support.js";

export type SignalStage = "env" | "seed" | "startup" | "test";

function descendantSource(name: string): string {
  return `const { writeFileSync } = require("node:fs");
process.on("SIGTERM", () => {});
writeFileSync(${JSON.stringify(`${name}.child.pid`)}, String(process.pid));
setInterval(() => {}, 1000);`;
}

function treeCommand(root: string, name: string, listen: boolean): string {
  return fixtureCommand(
    root,
    name,
    `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
process.on("SIGTERM", () => {});
spawn(process.execPath, ["-e", ${JSON.stringify(descendantSource(name))}], { stdio: "ignore" });
writeFileSync(${JSON.stringify(`${name}.pid`)}, String(process.pid));
${listen ? 'createServer((_request, response) => response.end("ok")).listen(Number(process.env.PORT), "127.0.0.1");' : ""}
setInterval(() => {}, 1000);`,
  );
}

export function signalScenario(
  root: string,
  stage: SignalStage,
): { args: string[]; names: string[] } {
  const args = ["--json", "--seed-command", markerCommand(root, "seed")];
  if (stage === "env") args.push("--env-command", treeCommand(root, "env", false));
  if (stage === "seed") args[2] = treeCommand(root, "seed", false);
  args.push("--start-command", treeCommand(root, "server", stage === "test"));
  args.push(
    "--test-command",
    stage === "test" ? treeCommand(root, "test", false) : markerCommand(root, "test"),
  );
  const names = stage === "test" ? ["server", "test"] : [stage === "startup" ? "server" : stage];
  return { args, names: names.flatMap((name) => [`${name}.pid`, `${name}.child.pid`]) };
}

export function scenarioPids(root: string, names: string[]): number[] {
  return names
    .filter((name) => existsSync(join(root, name)))
    .map((name) => Number(readFileSync(join(root, name), "utf8")));
}

export async function cleanScenario(
  run: ReturnType<typeof spawnMonkey>,
  root: string,
  names: string[],
): Promise<void> {
  const pids = [...scenarioPids(root, names), run.child.pid];
  for (const pid of pids) {
    if (!pid) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* Already stopped. */
    }
  }
  await run.exited;
  await run.closed;
}

export async function waitForExit(run: ReturnType<typeof spawnMonkey>): Promise<boolean> {
  return eventually(() => run.child.exitCode !== null || run.child.signalCode !== null);
}

export function concurrentScenario(
  root: string,
  baseUrl: string,
): { script: string; names: string[] } {
  const scenario = signalScenario(root, "env");
  const options = {
    skipSecurity: true,
    skipSeed: true,
    expectedReason: "Synthetic concurrent runner fixture",
  };
  const script = `const { runMonkeyTest } = await import(${JSON.stringify(runnerEntry())});
await Promise.all([
  runMonkeyTest(process.cwd(), ${JSON.stringify({ ...options, baseUrl })}),
  runMonkeyTest(process.cwd(), ${JSON.stringify({ ...options, envCommand: scenario.args[4] })}),
]);`;
  return { script, names: scenario.names };
}

export function completedStageCommand(root: string, inheritOutput: boolean): string {
  return fixtureCommand(
    root,
    "stage",
    `import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendantSource("stage"))}], {
  stdio: ${JSON.stringify(inheritOutput ? "inherit" : "ignore")},
});
child.unref();
const ready = setInterval(() => {
  if (existsSync("stage.child.pid")) clearInterval(ready);
}, 10);`,
  );
}

export function forkedServerCommands(root: string): { startCommand: string; testCommand: string } {
  serverCommand(root);
  const startCommand = fixtureCommand(
    root,
    "server-leader",
    `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
writeFileSync("server.leader.pid", String(process.pid));
const child = spawn(process.execPath, ["server.mjs"], { stdio: "ignore" });
child.unref();
setTimeout(() => {}, 500);`,
  );
  const testCommand = fixtureCommand(
    root,
    "test",
    `import { readFileSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
const leader = Number(readFileSync("server.leader.pid", "utf8"));
let running = true;
while (running) {
  try { process.kill(leader, 0); } catch { running = false; }
  if (running) await delay(25);
}
await delay(50);
const response = await fetch(process.env.MONKEY_BASE_URL);
if (response.ok) writeFileSync("test.ran", "yes");`,
  );
  return { startCommand, testCommand };
}
