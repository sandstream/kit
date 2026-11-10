import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
import { it } from "node:test";
import { readAuditLog } from "./audit.js";
import { createCliContractFixture } from "./cli-contract.test-support.js";
import { projectConfig } from "./governance-outcome.test-support.js";

it("reserves the only allowance before a second CLI process can execute", async (t) => {
  const fixture = createCliContractFixture(
    projectConfig.replace("max_operations_per_hour = 2", "max_operations_per_hour = 1"),
  );
  t.after(() => fixture.cleanup());
  const source = import.meta.url.endsWith(".ts");
  const cli = fileURLToPath(new URL(source ? "./cli.ts" : "./cli.js", import.meta.url));
  const loader = source ? ["--import", import.meta.resolve("tsx")] : [];
  const script = `const fs = require('node:fs'); fs.writeFileSync('first-started', 'yes');
const deadline = setTimeout(() => process.exit(7), 15000);
const timer = setInterval(() => { if (fs.existsSync('release-first')) {
clearInterval(timer); clearTimeout(deadline); } }, 10);`;
  const first = spawn(
    process.execPath,
    [...loader, cli, "run", "--", process.execPath, "-e", script],
    {
      cwd: fixture.cwd,
      env: fixture.env,
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let stderr = "";
  first.stderr.on("data", (data) => (stderr += data));
  const closed = new Promise<number | null>((resolve, reject) => {
    first.once("error", reject);
    first.once("close", resolve);
  });
  try {
    const deadline = Date.now() + 10000;
    while (!existsSync(join(fixture.cwd, "first-started")) && Date.now() < deadline) {
      assert.equal(first.exitCode, null, stderr);
      await setTimeout(10);
    }
    assert.ok(existsSync(join(fixture.cwd, "first-started")), stderr);
    const second = fixture.run([
      "run",
      "--",
      process.execPath,
      "-e",
      "require('node:fs').writeFileSync('second-started', 'unexpected')",
    ]);
    assert.equal(second.status, 1, second.stdout + second.stderr);
    assert.match(second.stderr, /Operation budget exceeded/);
    assert.equal(existsSync(join(fixture.cwd, "second-started")), false);
  } finally {
    writeFileSync(join(fixture.cwd, "release-first"), "yes");
    assert.equal(await closed, 0, stderr);
  }
  const status = fixture.run(["whoami", "--json"]);
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).budget.operations_used, 1);
  const events = await readAuditLog(join(fixture.cwd, ".kit-audit.jsonl"));
  assert.equal(events.filter((event) => event.success).length, 1);
  assert.equal(events.filter((event) => !event.success).length, 1);
});
