/** Verify write protection at the synchronous receipt file boundaries. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { appendReceiptHistory } from "./review-receipt-files.js";
import { publishReviewReceipt } from "./review-receipt-publish.js";
import { beginReviewTransaction, writeRecoveryPending } from "./review-receipt-transaction.js";
import { getAuditAnchorKey } from "./audit-anchor.js";
import { assertReviewWritable, withReviewWrite } from "./review-receipt-write-guard.js";
import { assessUnknownPending } from "./review-receipt-pending.js";
import { persistHistory } from "./review-receipt-history-io.js";
import { privateFileIsControlled } from "./utils/secure-perms.js";

it("does not claim a completed audit when a synchronous caller exits immediately", () => {
  const root = mkdtempSync(join(tmpdir(), "kit-refusal-exit-"));
  try {
    const moduleUrl = new URL("./review-receipt-write-guard.js", import.meta.url).href;
    const script = `import { assertReviewWritable } from ${JSON.stringify(moduleUrl)}; try { assertReviewWritable(process.argv[1], "test-sync-refusal"); } catch { process.exit(0); } process.exit(2);`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, root], {
      env: { ...process.env, KIT_READ_ONLY: "1", KIT_AUDIT_ANCHOR: "0" },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const audit = join(root, ".kit-audit.jsonl");
    assert.equal(
      existsSync(audit) && readFileSync(audit, "utf8").includes("test-sync-refusal"),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

async function waitForAudit(root: string, expected: string[]): Promise<void> {
  const path = join(root, ".kit-audit.jsonl");
  for (let attempt = 0; attempt < 500; attempt++) {
    const text = existsSync(path) ? readFileSync(path, "utf8") : "";
    if (expected.every((name) => text.includes(name))) return;
    await new Promise((done) => setTimeout(done, 20));
  }
  throw new Error("read-only refusals did not reach the audit log");
}

it("refuses direct file operations and audits each refusal", async () => {
  const root = mkdtempSync(join(tmpdir(), "kit-receipt-guard-"));
  const previous = process.env.KIT_READ_ONLY;
  const previousAnchor = process.env.KIT_AUDIT_ANCHOR;
  process.env.KIT_READ_ONLY = "1";
  process.env.KIT_AUDIT_ANCHOR = "0";
  try {
    assert.throws(() => beginReviewTransaction(root, () => root), /read-only mode active/);
    assert.throws(
      () => appendReceiptHistory(join(root, "history"), "data\n"),
      /read-only mode active/,
    );
    assert.throws(() => publishReviewReceipt(root, "data"), /read-only mode active/);
    const transaction = {
      root,
      dir: join(root, "lock"),
      runId: "a".repeat(32),
      pid: process.pid,
      host: "host",
    };
    const claim = {
      root,
      dir: join(transaction.dir, "recovery"),
      id: "b".repeat(32),
      pid: process.pid,
      host: "host",
    };
    assert.throws(() => writeRecoveryPending(transaction, claim, "data"), /read-only mode active/);
    assert.throws(
      () =>
        assessUnknownPending(JSON.parse("{}"), "", {
          transaction,
          claim,
          key: Buffer.alloc(32),
          acknowledge: true,
        }),
      /read-only mode active/,
    );
    assert.throws(
      () => persistHistory(root, JSON.parse("{}"), Buffer.alloc(32)),
      /read-only mode active/,
    );
    await waitForAudit(root, [
      "review-transaction",
      "review-history",
      "review-receipt-publish",
      "review-recovery-pending",
      "review-interruption-assessment",
    ]);
    assert.deepEqual(readdirSync(root), [".kit-audit.jsonl"]);
  } finally {
    if (previous === undefined) delete process.env.KIT_READ_ONLY;
    else process.env.KIT_READ_ONLY = previous;
    if (previousAnchor === undefined) delete process.env.KIT_AUDIT_ANCHOR;
    else process.env.KIT_AUDIT_ANCHOR = previousAnchor;
    rmSync(root, { recursive: true, force: true });
  }
});

it("does not create a signing key after read-only mode starts", async () => {
  const root = mkdtempSync(join(tmpdir(), "kit-anchor-guard-"));
  const previous = process.env.KIT_READ_ONLY;
  const previousAnchor = process.env.KIT_AUDIT_ANCHOR;
  delete process.env.KIT_READ_ONLY;
  process.env.KIT_AUDIT_ANCHOR = "0";
  let calls = 0;
  try {
    await assert.rejects(
      withReviewWrite(root, "review-prepare-receipt", () =>
        getAuditAnchorKey(join(root, "anchor"), () => {
          calls += 1;
          if (calls === 2) process.env.KIT_READ_ONLY = "1";
          assertReviewWritable(root, "review-prepare-receipt");
        }),
      ),
      /read-only mode active/,
    );
    assert.equal(existsSync(join(root, "anchor", "audit-anchor.key")), false);
    await waitForAudit(root, ["review-prepare-receipt"]);
  } finally {
    if (previous === undefined) delete process.env.KIT_READ_ONLY;
    else process.env.KIT_READ_ONLY = previous;
    if (previousAnchor === undefined) delete process.env.KIT_AUDIT_ANCHOR;
    else process.env.KIT_AUDIT_ANCHOR = previousAnchor;
    rmSync(root, { recursive: true, force: true });
  }
});

it("preserves a secured temporary key if read-only mode starts after its write", async () => {
  const root = mkdtempSync(join(tmpdir(), "kit-anchor-guard-"));
  const previous = process.env.KIT_READ_ONLY;
  const previousAnchor = process.env.KIT_AUDIT_ANCHOR;
  delete process.env.KIT_READ_ONLY;
  process.env.KIT_AUDIT_ANCHOR = "0";
  let calls = 0;
  try {
    const anchor = join(root, "anchor");
    await assert.rejects(
      withReviewWrite(root, "review-prepare-receipt", () =>
        getAuditAnchorKey(anchor, () => {
          calls += 1;
          if (calls === 5) process.env.KIT_READ_ONLY = "1";
          assertReviewWritable(root, "review-prepare-receipt");
        }),
      ),
      /read-only mode active/,
    );
    assert.equal(existsSync(join(anchor, "audit-anchor.key")), false);
    const temp = readdirSync(anchor).find((name) =>
      /^\.kit-audit-anchor-[a-f0-9]{32}\.tmp$/.test(name),
    );
    assert.ok(temp);
    const path = join(anchor, temp);
    assert.match(readFileSync(path, "utf8"), /^[a-f0-9]{64}\n$/);
    assert.equal(privateFileIsControlled(path), true);
    await waitForAudit(root, ["review-prepare-receipt"]);
  } finally {
    if (previous === undefined) delete process.env.KIT_READ_ONLY;
    else process.env.KIT_READ_ONLY = previous;
    if (previousAnchor === undefined) delete process.env.KIT_AUDIT_ANCHOR;
    else process.env.KIT_AUDIT_ANCHOR = previousAnchor;
    rmSync(root, { recursive: true, force: true });
  }
});

it("preserves the receipt when read-only mode starts during publication", async () => {
  const root = mkdtempSync(join(tmpdir(), "kit-receipt-guard-"));
  const previous = process.env.KIT_READ_ONLY;
  const previousAnchor = process.env.KIT_AUDIT_ANCHOR;
  delete process.env.KIT_READ_ONLY;
  process.env.KIT_AUDIT_ANCHOR = "0";
  try {
    const path = join(root, ".kit-review-receipt.json");
    writeFileSync(path, "original");
    assert.throws(
      () =>
        publishReviewReceipt(root, "new", {
          afterTempWrite: () => {
            process.env.KIT_READ_ONLY = "1";
          },
        }),
      /read-only mode active/,
    );
    assert.equal(readFileSync(path, "utf8"), "original");
    assert.ok(readdirSync(root).some((name) => name.endsWith(".tmp")));
    await waitForAudit(root, ["review-receipt-publish"]);
  } finally {
    if (previous === undefined) delete process.env.KIT_READ_ONLY;
    else process.env.KIT_READ_ONLY = previous;
    if (previousAnchor === undefined) delete process.env.KIT_AUDIT_ANCHOR;
    else process.env.KIT_AUDIT_ANCHOR = previousAnchor;
    rmSync(root, { recursive: true, force: true });
  }
});

it("preserves both history links when read-only mode starts after publication", async () => {
  const root = mkdtempSync(join(tmpdir(), "kit-history-guard-"));
  const previous = process.env.KIT_READ_ONLY;
  const previousAnchor = process.env.KIT_AUDIT_ANCHOR;
  delete process.env.KIT_READ_ONLY;
  process.env.KIT_AUDIT_ANCHOR = "0";
  try {
    const path = join(root, "history");
    assert.throws(
      () =>
        appendReceiptHistory(path, "failure\n", {
          publish: (source, destination) => {
            linkSync(source, destination);
            process.env.KIT_READ_ONLY = "1";
          },
        }),
      /read-only mode active/,
    );
    assert.equal(readFileSync(path, "utf8"), "");
    const temp = readdirSync(root).find((name) => /^\.kit-receipt-.*\.tmp$/.test(name));
    assert.ok(temp);
    assert.equal(lstatSync(path).ino, lstatSync(join(root, temp)).ino);
    assert.equal(lstatSync(path).nlink, 2);
    await waitForAudit(root, ["review-history"]);
  } finally {
    if (previous === undefined) delete process.env.KIT_READ_ONLY;
    else process.env.KIT_READ_ONLY = previous;
    if (previousAnchor === undefined) delete process.env.KIT_AUDIT_ANCHOR;
    else process.env.KIT_AUDIT_ANCHOR = previousAnchor;
    rmSync(root, { recursive: true, force: true });
  }
});
