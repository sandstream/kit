import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import { setTimeout as pause } from "node:timers/promises";
import { launchFixture } from "./launch-candidate.test-support.js";
import { hasNativeImageTool } from "./native-image.test-support.js";

type Fixture = Awaited<ReturnType<typeof launchFixture>>;

function runInProcess(f: Fixture) {
  const script = join(f.root, "trusted-test-parent.mjs");
  writeFileSync(
    script,
    [
      "import { IncomingTrustStore } from " +
        JSON.stringify(new URL("./authority-store.js", import.meta.url).href),
      "import { launchIncomingCandidate } from " +
        JSON.stringify(new URL("./launch-candidate.js", import.meta.url).href),
      "const [directory, repository, source, policy, verification] = process.argv.slice(2);",
      "process.send(launchIncomingCandidate({store:new IncomingTrustStore(directory), repository, source, policy:JSON.parse(policy), verification:JSON.parse(verification)}));",
      "process.disconnect();",
    ].join("\n"),
  );
  return fork(
    script,
    [f.directory, f.repository, f.source, JSON.stringify(f.policy), JSON.stringify(f.verification)],
    { execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "ignore", "ipc"] },
  );
}

it(
  "holds the generation lock during the bounded run and reaps the isolated process",
  {
    skip: !hasNativeImageTool || process.arch !== "arm64",
  },
  async () => {
    const f = await launchFixture(
      () =>
        [
          'import fs from "node:fs";',
          'fs.writeFileSync("started", "yes");',
          "console.log(process.pid);",
          "setTimeout(() => {}, 8000);",
        ].join("\n"),
      4000,
    );
    const competitor = new DatabaseSync(join(f.directory, "authority.sqlite"));
    try {
      competitor.exec("PRAGMA busy_timeout = 0");
      const worker = runInProcess(f);
      const limit = AbortSignal.timeout(25_000);
      const result = once(worker, "message", { signal: limit });
      const exit = once(worker, "exit");
      const monitor = verifyLockDuringRun(f, competitor, limit);
      const [entry, completion, lock] = await Promise.allSettled([result, exit, monitor]);
      if (entry.status === "rejected") throw entry.reason;
      if (completion.status === "rejected") throw completion.reason;
      if (lock.status === "rejected") throw lock.reason;
      const receipt = entry.value;
      const closed = completion.value;
      assert.deepEqual(closed, [0, null]);
      const [run] = receipt;
      assert.equal(run.ran, true, JSON.stringify(run));
      assert.equal(run.outcome, "timed-out");
      const pid = Number(run.stdout.trim());
      assert.ok(Number.isInteger(pid) && pid > 0);
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      competitor.exec("BEGIN IMMEDIATE");
      competitor.exec("ROLLBACK");
    } finally {
      competitor.close();
      f.cleanup();
    }
  },
);

async function verifyLockDuringRun(f: Fixture, db: DatabaseSync, signal: AbortSignal) {
  const file = join(f.policy.outputDirectory, "started");
  while (!existsSync(file)) await pause(20, undefined, { signal });
  assert.throws(() => db.exec("BEGIN IMMEDIATE"), /locked|busy/);
}
