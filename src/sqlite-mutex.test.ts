import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { verifyAuditChain } from "./audit.js";
import {
  auditFixture,
  runAuditWorkers,
  startAuditWorker,
} from "./audit-concurrency.test-support.js";

type Fixture = ReturnType<typeof auditFixture>;

function reportCleanup(t: TestContext, fixture: Fixture): void {
  // The fixture registers its cleanup first. Observe it after every child has closed.
  t.after(async () => {
    await Promise.all(fixture.workers.map((worker) => worker.done));
    assert.equal(existsSync(fixture.root), false, "The helper must remove its fixture");
    t.diagnostic(`Cleanup: ${fixture.workers.length} child close events; removed ${fixture.root}`);
  });
}

function logPath(fixture: Fixture, logFile = ".kit-audit.jsonl"): string {
  return join(realpathSync(fixture.project), logFile);
}

function assertLog(path: string, operations: string[]): string {
  const content = readFileSync(path, "utf8");
  assert.deepEqual(verifyAuditChain(content), { ok: true, entries: operations.length });
  assert.deepEqual(
    content
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).operation),
    operations,
  );
  return content;
}

// Pause the real filesystem write. The caller can then crash the process or deny the write.
// Restore the native binding before the pause so later appends use the real filesystem.
const pauseWrite = `
  const fs = (await import("node:fs/promises")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  // Match the product's canonical path. The promise realpath expands Windows short names
  // (RUNNER~1), the synchronous one does not, and the comparison below is by string.
  const { realpathSync } = await import("node:fs");
  const target = join(realpathSync(project), ".kit-audit.jsonl");
  const appendFile = fs.appendFile;
  let reachedWrite;
  const writeReached = new Promise((resolve) => { reachedWrite = resolve; });
  fs.appendFile = async (...args) => {
    if (args[0] === target) {
      fs.appendFile = appendFile;
      syncBuiltinESMExports();
      const resume = next();
      signal("write-paused");
      reachedWrite();
      await resume;
    }
    return appendFile(...args);
  };
  syncBuiltinESMExports();
`;

// Observe a real SQLite busy result to synchronize with an actual OS lock attempt.
// Preserve the result and exception. No lock or audit operation is replaced.
const observeContention = `
  const { DatabaseSync } = await import("node:sqlite");
  const exec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function (...args) {
    try { return exec.apply(this, args); }
    catch (error) {
      if (error.code === "ERR_SQLITE_ERROR" && [5, 6].includes(error.errcode & 0xff)) {
        DatabaseSync.prototype.exec = exec;
        signal("contended");
      }
      throw error;
    }
  };
`;

test(
  "a crashed audit writer releases its OS lock for a waiting append",
  { timeout: 30_000 },
  async (t) => {
    const fixture = auditFixture(t);
    reportCleanup(t, fixture);
    const holder = startAuditWorker(
      fixture,
      `
    assert.equal(await audit.appendAuditEventDirect(event("seed"), { cwd: project }), true);
    ${pauseWrite}
    await audit.appendAuditEventDirect(event("crashed-before-write"), { cwd: project });
    assert.fail("The paused writer must be killed before its write resumes");
  `,
    );
    await holder.wait("ready");
    holder.child.send("start");
    await holder.wait("write-paused");
    const before = assertLog(logPath(fixture), ["seed"]);

    const waiter = startAuditWorker(
      fixture,
      `
    ${observeContention}
    assert.equal(await audit.appendAuditEventDirect(event("after-crash"), { cwd: project }), true);
  `,
    );
    await waiter.wait("ready");
    waiter.child.send("start");
    await waiter.wait("contended");
    assert.equal(readFileSync(logPath(fixture), "utf8"), before);

    assert.equal(holder.child.kill("SIGKILL"), true);
    await holder.done;
    assert.equal(holder.child.signalCode, "SIGKILL");
    await waiter.finish();
    assertLog(logPath(fixture), ["seed", "after-crash"]);
  },
);

test(
  "audit acquisition stops after five seconds without an append and can recover",
  { timeout: 30_000 },
  async (t) => {
    const fixture = auditFixture(t);
    reportCleanup(t, fixture);
    await runAuditWorkers([
      startAuditWorker(
        fixture,
        `
    assert.equal(await audit.appendAuditEventDirect(event("seed"), { cwd: project }), true);
  `,
      ),
    ]);
    const before = assertLog(logPath(fixture), ["seed"]);
    const holder = startAuditWorker(
      fixture,
      `
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(${JSON.stringify(logPath(fixture) + ".lock.sqlite")});
    try {
      database.exec("BEGIN IMMEDIATE");
      const release = next();
      signal("locked");
      await release;
    } finally { database.close(); }
  `,
    );
    await holder.wait("ready");
    holder.child.send("start");
    await holder.wait("locked");

    const waiter = startAuditWorker(
      fixture,
      `
    const started = performance.now();
    assert.equal(await audit.appendAuditEventDirect(event("timed-out"), { cwd: project }), false);
    const elapsed = performance.now() - started;
    assert.ok(elapsed >= 4800 && elapsed < 7500, "Acquisition took " + elapsed + " ms");
    signal("elapsed:" + Math.round(elapsed));
    const retry = next();
    signal("timed-out");
    await retry;
    assert.equal(await audit.appendAuditEventDirect(event("after-timeout"), { cwd: project }), true);
  `,
    );
    await waiter.wait("ready");
    waiter.child.send("start");
    await waiter.wait("timed-out");
    assert.equal(holder.child.exitCode, null);
    assert.equal(holder.child.signalCode, null);
    assert.equal(assertLog(logPath(fixture), ["seed"]), before);
    t.diagnostic(waiter.messages.find((message) => message.startsWith("elapsed:"))!);

    holder.child.send("release");
    await holder.finish();
    assert.equal(readFileSync(logPath(fixture), "utf8"), before);
    waiter.child.send("retry");
    await waiter.finish();
    assertLog(logPath(fixture), ["seed", "after-timeout"]);
  },
);

test(
  "a failed audit write releases both local and OS locks before the process exits",
  { timeout: 30_000 },
  async (t) => {
    const fixture = auditFixture(t);
    reportCleanup(t, fixture);
    const writer = startAuditWorker(
      fixture,
      `
    assert.equal(await audit.appendAuditEventDirect(event("seed"), { cwd: project }), true);
    ${pauseWrite}
    assert.equal(await audit.appendAuditEventDirect(event("failed-write"), { cwd: project }), false);
    const retry = next();
    signal("write-failed");
    await retry;
    assert.equal(await audit.appendAuditEventDirect(event("same-process-recovery"), { cwd: project }), true);
    const finish = next();
    signal("recovered");
    await finish;
  `,
    );
    await writer.wait("ready");
    writer.child.send("start");
    await writer.wait("write-paused");
    const path = logPath(fixture);
    const before = assertLog(path, ["seed"]);

    // Substitute a directory only after acquisition so the real append fails with EISDIR.
    const saved = join(fixture.project, "saved.jsonl");
    renameSync(path, saved);
    mkdirSync(path);
    writer.child.send("fail-write");
    await writer.wait("write-failed");
    assert.equal(readFileSync(saved, "utf8"), before);
    rmSync(path, { recursive: true });
    renameSync(saved, path);
    assert.equal(assertLog(path, ["seed"]), before);

    // Keep the failed writer alive: exit must not conceal a leaked SQLite connection.
    await runAuditWorkers([
      startAuditWorker(
        fixture,
        `
    assert.equal(await audit.appendAuditEventDirect(event("other-process-recovery"), { cwd: project }), true);
  `,
      ),
    ]);
    assertLog(path, ["seed", "other-process-recovery"]);
    writer.child.send("retry");
    await writer.wait("recovered");
    assertLog(path, ["seed", "other-process-recovery", "same-process-recovery"]);
    writer.child.send("finish");
    await writer.finish();
  },
);

test(
  "independent audit logs can append while another log has a live writer",
  { timeout: 30_000 },
  async (t) => {
    const fixture = auditFixture(t);
    reportCleanup(t, fixture);
    const holder = startAuditWorker(
      fixture,
      `
    assert.equal(await audit.appendAuditEventDirect(event("seed"), { cwd: project }), true);
    ${pauseWrite}
    const pending = audit.appendAuditEventDirect(event("held-write"), { cwd: project });
    await writeReached;
    assert.equal(await audit.appendAuditEventDirect(event("independent-local"), {
      cwd: project, logFile: "independent.jsonl",
    }), true);
    signal("independent-local");
    assert.equal(await pending, true);
  `,
    );
    await holder.wait("ready");
    holder.child.send("start");
    await holder.wait("independent-local");
    const before = assertLog(logPath(fixture), ["seed"]);
    assertLog(logPath(fixture, "independent.jsonl"), ["independent-local"]);

    const waiter = startAuditWorker(
      fixture,
      `
    ${observeContention}
    assert.equal(await audit.appendAuditEventDirect(event("after-held-write"), { cwd: project }), true);
  `,
    );
    await waiter.wait("ready");
    waiter.child.send("start");
    await waiter.wait("contended");
    await runAuditWorkers([
      startAuditWorker(
        fixture,
        `
    assert.equal(await audit.appendAuditEventDirect(event("independent-external"), {
      cwd: project, logFile: "independent.jsonl",
    }), true);
  `,
      ),
    ]);
    assert.equal(assertLog(logPath(fixture), ["seed"]), before);
    assertLog(logPath(fixture, "independent.jsonl"), ["independent-local", "independent-external"]);

    holder.child.send("resume-write");
    await Promise.all([holder.finish(), waiter.finish()]);
    assertLog(logPath(fixture), ["seed", "held-write", "after-held-write"]);
    assertLog(logPath(fixture, "independent.jsonl"), ["independent-local", "independent-external"]);
  },
);
