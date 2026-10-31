// Per-file wall time for one shard of the suite, printed as `TIMING <ms> <file>` lines (#675).
//
// The Windows workflow is the merge gate and its slowest shard sets the time. Splitting by file
// size is within 4% of ideal on Linux, yet on Windows one shard is consistently ~1.3x the others,
// so the weights that matter are Windows ones and only a Windows runner can produce them. This
// runs each test file of the shard as its own `node --test`, two at a time (the concurrency
// Windows holds), and prints its wall time to stdout so the job log carries the data. It is a
// measurement, not a gate: it exits 0 whatever the tests do and reports failures as a count.
import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseShard, selectShard } from "./test-shard.mjs";

function collect(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collect(p));
    else if (entry.name.endsWith(".test.js")) out.push(p);
  }
  return out;
}

const all = collect("dist");
if (existsSync("packages")) {
  for (const pkg of readdirSync("packages", { withFileTypes: true })) {
    const dist = join("packages", pkg.name, "dist");
    if (pkg.isDirectory() && existsSync(dist)) all.push(...collect(dist));
  }
}
const shard = parseShard(process.env.KIT_TEST_SHARD);
const files = shard ? selectShard(all, shard, (f) => statSync(f).size) : all;
const env = {
  ...process.env,
  KIT_NON_INTERACTIVE: "1",
  KIT_BUMBLEBEE: "0",
  KIT_NO_FAILURE_SIM: "1",
  KIT_NO_UPDATE_CHECK: "1",
  KIT_AUDIT_ANCHOR: "0",
};

let next = 0;
let failed = 0;
async function worker() {
  while (next < files.length) {
    const file = files[next++];
    const start = Date.now();
    const code = await new Promise((done) => {
      const child = spawn(process.execPath, ["--test", "--test-timeout=180000", file], {
        env,
        stdio: "ignore",
      });
      child.on("close", done);
    });
    if (code !== 0) failed++;
    console.log(`TIMING ${Date.now() - start} ${file.split("\\").join("/")}`);
  }
}
const wall = Date.now();
await Promise.all([worker(), worker()]);
console.log(`TIMING-SUMMARY files=${files.length} failed=${failed} wall_ms=${Date.now() - wall}`);
