import assert from "node:assert/strict";
import { fork, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { setTimeout as pause } from "node:timers/promises";
import { launchFixture, NATIVE_RUN_TEST_WINDOW_MS } from "./launch-candidate.test-support.js";
import { ejectFixtureImages, hasNativeImageTool } from "./native-image.test-support.js";

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
      const limit = AbortSignal.timeout(NATIVE_RUN_TEST_WINDOW_MS);
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

function startSignedCli(f: Fixture, scratch: string) {
  const report = join(f.root, "report.json");
  const policy = join(f.root, "policy.json");
  writeFileSync(report, JSON.stringify(f.verification));
  writeFileSync(policy, JSON.stringify(f.policy));
  const cli = fileURLToPath(new URL("../cli.js", import.meta.url));
  return spawn(
    process.execPath,
    [
      cli,
      "security",
      "incoming",
      "run",
      "--json",
      "--repo",
      f.repository,
      "--store",
      f.directory,
      "--snapshot-dir",
      f.source,
      "--policy",
      policy,
      "--verification",
      report,
    ],
    {
      cwd: f.repository,
      env: { ...process.env, TMPDIR: scratch, KIT_READ_ONLY: "0", KIT_AUDIT_ANCHOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

function killTestWorkload(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function hasTemporaryRuntime(scratch: string): boolean {
  return readdirSync(scratch).some((name) => /^kit-incoming-(sealed|runtime)-/.test(name));
}

it(
  "reaps the suspended signed CLI workload and ejects its input and executable volumes after Kit dies",
  { skip: !hasNativeImageTool || process.arch !== "arm64" },
  async () => {
    const f = await launchFixture(
      () =>
        [
          'import { renameSync, writeFileSync } from "node:fs";',
          'writeFileSync("pid.tmp", String(process.pid));',
          'renameSync("pid.tmp", "pid");',
          "setTimeout(() => {}, 30000);",
        ].join("\n"),
      30_000,
    );
    const scratch = join(f.root, "kit-temp");
    mkdirSync(scratch, { mode: 0o700 });
    const kit = startSignedCli(f, scratch);
    const stopped = once(kit, "exit");
    const closed = once(kit, "close");
    let diagnostic = "";
    for (const stream of [kit.stdout, kit.stderr]) {
      stream.setEncoding("utf8").on("data", (chunk: string) => {
        diagnostic = (diagnostic + chunk).slice(-4096);
      });
    }
    let pid: number | undefined;
    try {
      const marker = join(f.policy.outputDirectory, "pid");
      const startup = AbortSignal.timeout(NATIVE_RUN_TEST_WINDOW_MS);
      while (!existsSync(marker) && kit.exitCode === null && kit.signalCode === null)
        await pause(50, undefined, { signal: startup });
      if (!existsSync(marker)) {
        const [code, signal] = await closed;
        assert.fail(
          `Kit stopped before the signed workload started (${code}, ${signal}): ${diagnostic}`,
        );
      }
      pid = Number(readFileSync(marker, "utf8"));
      assert.ok(Number.isInteger(pid) && pid > 0);
      assert.equal(
        readdirSync(scratch).filter((name) => name.startsWith("kit-incoming-runtime-")).length,
        1,
      );
      assert.equal(
        readdirSync(scratch).filter((name) => name.startsWith("kit-incoming-sealed-")).length,
        2,
      );
      process.kill(pid, "SIGSTOP");
      assert.ok(kit.kill("SIGKILL"));
      assert.deepEqual(await stopped, [null, "SIGKILL"]);
      const teardown = AbortSignal.timeout(15_000);
      while (hasTemporaryRuntime(scratch)) await pause(50, undefined, { signal: teardown });
      assert.throws(() => process.kill(pid!, 0), { code: "ESRCH" });
      pid = undefined;
    } finally {
      try {
        if (kit.exitCode === null && kit.signalCode === null) {
          kit.kill("SIGKILL");
          await stopped;
        }
        if (pid && pid > 0) killTestWorkload(pid);
      } finally {
        try {
          const teardown = AbortSignal.timeout(15_000);
          while (hasTemporaryRuntime(scratch)) await pause(50, undefined, { signal: teardown });
        } finally {
          await ejectFixtureImages(scratch);
          f.cleanup();
        }
      }
    }
  },
);
