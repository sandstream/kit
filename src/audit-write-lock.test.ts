import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { verifyAuditChain } from "./audit.js";
import {
  auditCli,
  auditFixture,
  runAuditWorkers,
  startAuditWorker,
} from "./audit-concurrency.test-support.js";

test("concurrent audit calls preserve every admitted event in a verifiable chain", () => {
  const root = mkdtempSync(join(tmpdir(), "kit-audit-concurrency-"));
  const source = `
    import assert from "node:assert/strict";
    import { readFile } from "node:fs/promises";
    import { appendAuditEventDirect, verifyAuditChain } from ${JSON.stringify(new URL("./audit.js", import.meta.url).href)};
    const results = await Promise.all(Array.from({ length: 24 }, (_, index) =>
      appendAuditEventDirect({ operation: "concurrent-" + index, environment: "test", success: true }, { cwd: process.argv[1] })
    ));
    assert.equal(results.filter(Boolean).length, 24);
    const content = await readFile(process.argv[1] + "/.kit-audit.jsonl", "utf8");
    assert.deepEqual(verifyAuditChain(content), { ok: true, entries: 24 });
    assert.equal(new Set(content.trim().split("\\n").map((line) => JSON.parse(line).operation)).size, 24);
  `;
  try {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", source, root],
      {
        encoding: "utf8",
        timeout: 30_000,
        env: {
          ...process.env,
          HOME: root,
          USERPROFILE: root,
          KIT_IDENTITY_DIR: join(root, "identity"),
          KIT_AUDIT_ANCHOR_DIR: join(root, "anchors"),
          KIT_AUDIT_ANCHOR: "0",
          KIT_KEYSTORE: "file",
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a partial audit record refuses admission and preserves the damaged evidence", async (t) => {
  const fixture = auditFixture(t);
  await runAuditWorkers([
    startAuditWorker(
      fixture,
      `
    const logPath = join(project, ".kit-audit.jsonl");
    assert.equal(await audit.appendAuditEventDirect(event("first"), { cwd: project }), true);
    const original = await readFile(logPath, "utf8");
    const partial = original + '{"operation":"unfinished';
    await writeFile(logPath, partial);
    assert.equal(await audit.appendAuditEventDirect(event("must-not-proceed"), { cwd: project }), false);
    assert.equal(await readFile(logPath, "utf8"), partial);
    await writeFile(logPath, original);
    assert.equal(await audit.appendAuditEventDirect(event("recovered"), { cwd: project }), true);
    assert.deepEqual(audit.verifyAuditChain(await readFile(logPath, "utf8")), { ok: true, entries: 2 });
  `,
    ),
  ]);
});

test("a valid final record without a newline remains a valid chain after append", async (t) => {
  const fixture = auditFixture(t);
  await runAuditWorkers([
    startAuditWorker(
      fixture,
      `
    const logPath = join(project, ".kit-audit.jsonl");
    assert.equal(await audit.appendAuditEventDirect(event("first"), { cwd: project }), true);
    const original = await readFile(logPath, "utf8");
    await writeFile(logPath, original.trimEnd());
    assert.equal(await audit.appendAuditEventDirect(event("second"), { cwd: project }), true);
    const current = await readFile(logPath, "utf8");
    assert.ok(current.startsWith(original));
    assert.deepEqual(audit.verifyAuditChain(current), { ok: true, entries: 2 });
  `,
    ),
  ]);
});

test("separate direct and governed writers preserve one chain and a complete anchor", async (t) => {
  const fixture = auditFixture(t, true);
  const alias = join(fixture.root, "alias");
  symlinkSync(fixture.project, alias, process.platform === "win32" ? "junction" : "dir");
  const workers = Array.from({ length: 8 }, (_, index) =>
    startAuditWorker(
      fixture,
      `
    const cwd = ${JSON.stringify(index % 2 ? alias : fixture.project)};
    const config = {
      enabled: true, environment: "test", access: {},
      agent: { id: "test", name: "Test" }, audit: { enabled: true },
      approval: {}, secrets: {}, revocation: {}, scan: {}, containment: {},
    };
    assert.equal(await audit.appendAuditEventDirect(event("direct-${index}"), { cwd }), true);
    assert.equal(await audit.logAuditEvent(config, event("governed-${index}"), { cwd }), true);
  `,
    ),
  );
  await runAuditWorkers(workers);
  const content = readFileSync(join(fixture.project, ".kit-audit.jsonl"), "utf8");
  assert.deepEqual(verifyAuditChain(content), { ok: true, entries: 16 });
  assert.equal(
    new Set(
      content
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).operation),
    ).size,
    16,
  );
  await runAuditWorkers([
    startAuditWorker(
      fixture,
      `
    const logPath = join(project, ".kit-audit.jsonl");
    const content = await readFile(logPath, "utf8");
    const record = await anchor.readAnchorRecord(logPath);
    const key = await anchor.tryReadAuditAnchorKey();
    const verdict = anchor.verifyAgainstAnchor(content, record, key);
    assert.equal(verdict.status, "anchored-ok");
    assert.equal(verdict.newSinceAnchor, 0);
    assert.equal(record.count, 16);
  `,
    ),
  ]);
  const cli = auditCli(fixture, ["verify", "--strict"]);
  assert.equal(cli.status, 0, cli.stderr + cli.stdout);
});
