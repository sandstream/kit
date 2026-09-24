import { spawn } from "node:child_process";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { SyncConfig } from "./remote-sync.js";

const worker = String.raw`
import cp from "node:child_process";
import fs from "node:fs";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
const [moduleUrl, root, serialized, name, peer] = process.argv.slice(1);
const original = cp.execFileSync;
let coordinated = false;
cp.execFileSync = function(command, args, options) {
  if (command === "git" && args.includes("push") && !coordinated) {
    coordinated = true;
    fs.writeFileSync(join(root, name + ".ready"), "ready");
    const deadline = Date.now() + 15000;
    const pause = new Int32Array(new SharedArrayBuffer(4));
    while (!fs.existsSync(join(root, peer + ".ready"))) {
      if (Date.now() > deadline) throw new Error("publisher peer never reached Git push");
      Atomics.wait(pause, 0, 0, 10);
    }
  }
  return original(command, args, options);
};
syncBuiltinESMExports();
const { pushMemory } = await import(moduleUrl);
const result = pushMemory(JSON.parse(serialized), process.env.KIT_MEMORY_PASSPHRASE, root);
process.stdout.write(JSON.stringify(result));
`;

/** Coordinate real Git publishers, never replace Git's result or publication. */
export function racePublisher(
  t: TestContext,
  dir: string,
  config: SyncConfig,
  passphrase: string,
  name: "a" | "b",
) {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      worker,
      new URL("./remote-sync.js", import.meta.url).href,
      dir,
      JSON.stringify(config),
      name,
      name === "a" ? "b" : "a",
    ],
    {
      env: {
        ...process.env,
        KIT_MEMORY_DIR: join(dir, name),
        KIT_MEMORY_DB: join(dir, name, "memory.db"),
        KIT_DEVICE_ID: `causal-git-${name}`,
        KIT_MEMORY_PASSPHRASE: passphrase,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (data: string) => {
    stdout += data;
  });
  child.stderr.setEncoding("utf8").on("data", (data: string) => {
    stderr += data;
  });
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}
