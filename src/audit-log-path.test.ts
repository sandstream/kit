import assert from "node:assert/strict";
import { readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  auditCli,
  auditFixture,
  runAuditWorkers,
  startAuditWorker,
} from "./audit-concurrency.test-support.js";

test("a legacy seal under a directory alias advances and verifies through both paths", async (t) => {
  const fixture = auditFixture(t, true);
  const alias = join(fixture.root, "alias");
  symlinkSync(fixture.project, alias, process.platform === "win32" ? "junction" : "dir");
  await runAuditWorkers([
    startAuditWorker(
      fixture,
      `
    const alias = ${JSON.stringify(alias)};
    assert.equal(await audit.appendAuditEventDirect(event("first"), { cwd: project }), true);
    assert.equal(await audit.appendAuditEventDirect(event("second"), { cwd: project }), true);
    const logPath = join(project, ".kit-audit.jsonl");
    const aliasPath = join(alias, ".kit-audit.jsonl");
    const record = await anchor.readAnchorRecord(logPath);
    await writeFile(anchor.anchorRecordPath(), JSON.stringify({ [aliasPath]: record }));
    assert.equal(await audit.appendAuditEventDirect(event("third"), { cwd: project }), true);
    assert.equal((await anchor.readAnchorRecord(logPath)).count, 3);
    assert.deepEqual(await anchor.readAnchorRecord(aliasPath), await anchor.readAnchorRecord(logPath));
    assert.equal((await anchor.listAnchoredLogs()).length, 1);
  `,
    ),
  ]);
  for (const project of [fixture.project, alias]) {
    const result = auditCli({ ...fixture, project }, ["verify", "--strict"]);
    assert.equal(result.status, 0, result.stderr + result.stdout);
  }
});

test("hard-linked logs refuse an append without changing either name", async (t) => {
  const fixture = auditFixture(t);
  await runAuditWorkers([
    startAuditWorker(
      fixture,
      `
    const { link } = await import("node:fs/promises");
    const original = join(project, ".kit-audit.jsonl"), alias = join(project, "linked.jsonl");
    assert.equal(await audit.appendAuditEventDirect(event("first"), { cwd: project }), true);
    const before = await readFile(original, "utf8");
    await link(original, alias);
    assert.equal(await audit.appendAuditEventDirect(event("blocked"), { cwd: project }), false);
    assert.equal(await audit.appendAuditEventDirect(event("also-blocked"), { cwd: project, logFile: "linked.jsonl" }), false);
    assert.equal(await readFile(original, "utf8"), before);
    assert.equal(await readFile(alias, "utf8"), before);
  `,
    ),
  ]);
  assert.equal(
    readFileSync(join(fixture.project, ".kit-audit.jsonl"), "utf8"),
    readFileSync(join(fixture.project, "linked.jsonl"), "utf8"),
  );
});

test("case aliases share a seal only when the filesystem treats them as one log", async (t) => {
  const fixture = auditFixture(t, true);
  await runAuditWorkers([
    startAuditWorker(
      fixture,
      `
    const { existsSync } = await import("node:fs");
    const first = join(project, ".kit-audit.jsonl"), second = join(project, ".KIT-AUDIT.JSONL");
    assert.equal(await audit.appendAuditEventDirect(event("first"), { cwd: project }), true);
    const sameFile = existsSync(second);
    assert.equal(await audit.appendAuditEventDirect(event("second"), { cwd: project, logFile: ".KIT-AUDIT.JSONL" }), true);
    const records = await anchor.listAnchoredLogs();
    assert.equal(records.length, sameFile ? 1 : 2);
    assert.equal((await anchor.readAnchorRecord(first)).count, sameFile ? 2 : 1);
    assert.equal((await anchor.readAnchorRecord(second)).count, sameFile ? 2 : 1);
    for (const path of [first, second]) {
      const content = await readFile(path, "utf8");
      const verdict = anchor.verifyAgainstAnchor(content, await anchor.readAnchorRecord(path), await anchor.tryReadAuditAnchorKey());
      assert.equal(verdict.status, "anchored-ok");
      assert.equal(verdict.newSinceAnchor, 0);
    }
  `,
    ),
  ]);
  const cli = auditCli(fixture, ["verify", "--all", "--strict"]);
  assert.equal(cli.status, 0, cli.stderr + cli.stdout);
});
