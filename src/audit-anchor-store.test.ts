import { test } from "node:test";
import assert from "node:assert/strict";
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  allowSlowLock,
  auditCli,
  auditFixture,
  runAuditWorkers,
  startAuditWorker,
} from "./audit-concurrency.test-support.js";

test("concurrent seals for different logs retain every anchor record", async (t) => {
  const fixture = auditFixture(t);
  allowSlowLock(fixture);
  await runAuditWorkers([
    startAuditWorker(
      fixture,
      `
    await anchor.getAuditAnchorKey();
    assert.equal(await audit.appendAuditEventDirect(event("seed"), { cwd: project }), true);
    const seed = join(project, ".kit-audit.jsonl");
    const content = await readFile(seed, "utf8");
    await anchor.anchorAuditLog(seed, content);
    const paths = Array.from({ length: 12 }, (_, index) => join(project, "log-" + index + ".jsonl"));
    await Promise.all(paths.map((path) => writeFile(path, content)));
    await Promise.all(paths.map((path) => anchor.anchorAuditLog(path, content)));
    const records = await anchor.listAnchoredLogs();
    assert.equal(records.length, 13);
    const key = await anchor.tryReadAuditAnchorKey();
    for (const { logPath, record } of records) {
      const verdict = anchor.verifyAgainstAnchor(await readFile(logPath, "utf8"), record, key);
      assert.equal(verdict.status, "anchored-ok");
      assert.equal(verdict.newSinceAnchor, 0);
    }
  `,
    ),
  ]);
});

test("a corrupt anchor index fails verification and remains available for recovery", async (t) => {
  const fixture = auditFixture(t, true);
  await runAuditWorkers([
    startAuditWorker(
      fixture,
      `
    assert.equal(await audit.appendAuditEventDirect(event("first"), { cwd: project }), true);
  `,
    ),
  ]);
  const index = join(fixture.home, "anchors", "audit-anchor.json");
  const damaged = '{"incomplete":';
  writeFileSync(index, damaged);
  const cli = auditCli(fixture, ["verify", "--all", "--strict", "--json"]);
  assert.equal(cli.status, 1, cli.stderr + cli.stdout);
  assert.equal(readFileSync(index, "utf8"), damaged);
  await runAuditWorkers([
    startAuditWorker(
      fixture,
      `
    await assert.rejects(anchor.listAnchoredLogs(), /anchor|index/i);
    const logPath = join(project, ".kit-audit.jsonl");
    await assert.rejects(anchor.anchorAuditLog(logPath, await readFile(logPath, "utf8")), /anchor|index/i);
  `,
    ),
  ]);
  assert.equal(readFileSync(index, "utf8"), damaged);
});

test("an explicit seal refuses an old snapshot without replacing the current anchor", async (t) => {
  const fixture = auditFixture(t);
  await runAuditWorkers([
    startAuditWorker(
      fixture,
      `
    assert.equal(await audit.appendAuditEventDirect(event("first"), { cwd: project }), true);
    const logPath = join(project, ".kit-audit.jsonl");
    const old = await readFile(logPath, "utf8");
    assert.equal(await audit.appendAuditEventDirect(event("second"), { cwd: project }), true);
    const current = await readFile(logPath, "utf8");
    await anchor.anchorAuditLog(logPath, current);
    const before = await readFile(anchor.anchorRecordPath(), "utf8");
    await assert.rejects(anchor.anchorAuditLog(logPath, old), /changed|snapshot/i);
    assert.equal(await readFile(anchor.anchorRecordPath(), "utf8"), before);
    assert.equal((await anchor.readAnchorRecord(logPath)).count, 2);
  `,
    ),
  ]);
});

test("an anchor index file alias retains the shared index and its other records", async (t) => {
  const fixture = auditFixture(t, true);
  await runAuditWorkers([
    startAuditWorker(
      fixture,
      `
    assert.equal(await audit.appendAuditEventDirect(event("first"), { cwd: project }), true);
  `,
    ),
  ]);
  const original = join(fixture.home, "anchors"),
    shared = join(fixture.root, "shared");
  mkdirSync(shared);
  copyFileSync(join(original, "audit-anchor.key"), join(shared, "audit-anchor.key"));
  const originalIndex = join(original, "audit-anchor.json"),
    sharedIndex = join(shared, "audit-anchor.json");
  renameSync(originalIndex, sharedIndex);
  try {
    symlinkSync(sharedIndex, originalIndex, "file");
  } catch (error) {
    if (
      process.platform === "win32" &&
      ["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")
    ) {
      t.skip(
        "expected: Windows denied file symlink creation; this runner needs Developer Mode or symlink permission.",
      );
      return;
    }
    throw error;
  }
  await runAuditWorkers([
    startAuditWorker(
      fixture,
      `
    assert.equal(await audit.appendAuditEventDirect(event("second"), { cwd: project, logFile: "other.jsonl" }), true);
    assert.equal((await anchor.listAnchoredLogs(${JSON.stringify(shared)})).length, 2);
  `,
    ),
  ]);
  assert.equal(lstatSync(originalIndex).isSymbolicLink(), true);
  assert.equal(readFileSync(originalIndex, "utf8"), readFileSync(sharedIndex, "utf8"));
});

test("a malformed external receipt cannot satisfy the external anchor requirement", async (t) => {
  const fixture = auditFixture(t, true);
  await runAuditWorkers([
    startAuditWorker(
      fixture,
      `
    assert.equal(await audit.appendAuditEventDirect(event("first"), { cwd: project }), true);
  `,
    ),
  ]);
  const path = join(fixture.home, "anchors", "audit-anchor.json");
  const index = JSON.parse(readFileSync(path, "utf8"));
  index[Object.keys(index)[0]].external = {};
  const damaged = JSON.stringify(index);
  writeFileSync(path, damaged);
  const cli = auditCli(fixture, ["verify", "--require-external"]);
  assert.equal(cli.status, 1, cli.stderr + cli.stdout);
  assert.equal(readFileSync(path, "utf8"), damaged);
});

test("conflicting alias receipts remain visible regardless of index order", async (t) => {
  const fixture = auditFixture(t, true);
  const alias = join(fixture.root, "alias");
  symlinkSync(fixture.project, alias, process.platform === "win32" ? "junction" : "dir");
  await runAuditWorkers([
    startAuditWorker(
      fixture,
      `
    assert.equal(await audit.appendAuditEventDirect(event("first"), { cwd: project }), true);
    const logPath = join(project, ".kit-audit.jsonl"), alias = ${JSON.stringify(join(alias, ".kit-audit.jsonl"))};
    const plain = await anchor.readAnchorRecord(logPath);
    const external = { ...plain, external: { token: "test-receipt", authority: "test", timestamp: "2026-11-06T00:00:00.000Z" } };
    for (const entries of [[[logPath, plain], [alias, external]], [[alias, external], [logPath, plain]]]) {
      const content = JSON.stringify(Object.fromEntries(entries));
      await writeFile(anchor.anchorRecordPath(), content);
      await assert.rejects(anchor.readAnchorRecord(logPath), /conflicting/i);
      await assert.rejects(anchor.readAnchorRecord(alias), /conflicting/i);
      assert.equal(await readFile(anchor.anchorRecordPath(), "utf8"), content);
    }
  `,
    ),
  ]);
});

test("a crash after append preserves an unsealed tail until explicit recovery", async (t) => {
  const fixture = auditFixture(t, true);
  const writer = startAuditWorker(
    fixture,
    `
    assert.equal(await audit.appendAuditEventDirect(event("seed"), { cwd: project }), true);
    const fs = (await import("node:fs/promises")).default;
    const { syncBuiltinESMExports } = await import("node:module");
    const append = fs.appendFile;
    fs.appendFile = async (...args) => {
      await append(...args);
      const wait = next(); signal("appended-before-anchor"); await wait;
    };
    syncBuiltinESMExports();
    await audit.appendAuditEventDirect(event("interrupted"), { cwd: project });
    assert.fail("The writer must stop before returning admission");
  `,
  );
  await writer.wait("ready");
  writer.child.send("start");
  await writer.wait("appended-before-anchor");
  writer.child.kill("SIGKILL");
  await writer.done;
  assert.equal(writer.child.signalCode, "SIGKILL");
  await runAuditWorkers([
    startAuditWorker(
      fixture,
      `
    assert.equal(await audit.appendAuditEventDirect(event("after-crash"), { cwd: project }), true);
    const logPath = join(project, ".kit-audit.jsonl");
    const content = await readFile(logPath, "utf8");
    assert.deepEqual(audit.verifyAuditChain(content), { ok: true, entries: 3 });
    assert.equal((await anchor.readAnchorRecord(logPath)).count, 1);
  `,
    ),
  ]);
  const rejected = auditCli(fixture, ["verify", "--strict"]);
  assert.equal(rejected.status, 1, rejected.stderr + rejected.stdout);
  assert.match(rejected.stderr + rejected.stdout, /UNSEALED|UNAUTHENTICATED/);
  const recovered = auditCli(fixture, ["anchor"]);
  assert.equal(recovered.status, 0, recovered.stderr + recovered.stdout);
  const verified = auditCli(fixture, ["verify", "--strict"]);
  assert.equal(verified.status, 0, verified.stderr + verified.stdout);
});
