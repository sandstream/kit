import { it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertReviewWritable,
  ReviewReadOnlyRefusal,
  withReviewWrite,
} from "./review-receipt-write-guard.js";

async function withProject(test: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "kit-review-write-guard-"));
  const readOnly = process.env.KIT_READ_ONLY;
  const anchor = process.env.KIT_AUDIT_ANCHOR;
  delete process.env.KIT_READ_ONLY;
  process.env.KIT_AUDIT_ANCHOR = "0";
  try {
    await test(root);
  } finally {
    if (readOnly === undefined) delete process.env.KIT_READ_ONLY;
    else process.env.KIT_READ_ONLY = readOnly;
    if (anchor === undefined) delete process.env.KIT_AUDIT_ANCHOR;
    else process.env.KIT_AUDIT_ANCHOR = anchor;
    rmSync(root, { recursive: true, force: true });
  }
}

function auditEntries(
  root: string,
): { operation: string; metadata: { refused_operation: string } }[] {
  const path = join(root, ".kit-audit.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

it("runs a writable action and returns its result without a refusal audit", async () => {
  await withProject(async (root) => {
    assert.doesNotThrow(() => assertReviewWritable(root));
    assert.equal(await withReviewWrite(root, "review-action", async () => 42), 42);
    assert.deepEqual(auditEntries(root), []);
  });
});

it("refuses a synchronous write and exposes the completed project audit", async () => {
  await withProject(async (root) => {
    process.env.KIT_READ_ONLY = "1";
    let refusal: unknown;
    try {
      assertReviewWritable(root);
    } catch (error) {
      refusal = error;
    }
    assert.ok(refusal instanceof ReviewReadOnlyRefusal);
    assert.match(refusal.message, /review-receipt/);
    await refusal.audit;
    const events = auditEntries(root);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.operation, "read-only-mode-refusal");
    assert.equal(events[0]?.metadata.refused_operation, "review-receipt");
  });
});

it("does not start an action in read-only mode and audits the requested operation", async () => {
  await withProject(async (root) => {
    process.env.KIT_READ_ONLY = "1";
    let called = false;
    await assert.rejects(
      withReviewWrite(root, "review-recover-receipt", async () => {
        called = true;
      }),
      ReviewReadOnlyRefusal,
    );
    assert.equal(called, false);
    const events = auditEntries(root);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.metadata.refused_operation, "review-recover-receipt");
  });
});

it("audits a refusal when read-only mode starts during a failing action", async () => {
  await withProject(async (root) => {
    await assert.rejects(
      withReviewWrite(root, "review-history", async () => {
        process.env.KIT_READ_ONLY = "1";
        throw new Error("write failed");
      }),
      ReviewReadOnlyRefusal,
    );
    const events = auditEntries(root);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.metadata.refused_operation, "review-history");
  });
});

it("awaits a nested refusal audit without recording it twice", async () => {
  await withProject(async (root) => {
    await assert.rejects(
      withReviewWrite(root, "outer", async () => {
        process.env.KIT_READ_ONLY = "1";
        assertReviewWritable(root, "inner");
      }),
      ReviewReadOnlyRefusal,
    );
    const events = auditEntries(root);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.metadata.refused_operation, "inner");
  });
});

it("preserves an action error when read-only mode stays inactive", async () => {
  await withProject(async (root) => {
    const failure = new Error("original failure");
    await assert.rejects(
      withReviewWrite(root, "review-action", async () => {
        throw failure;
      }),
      (error) => error === failure,
    );
    assert.deepEqual(auditEntries(root), []);
  });
});
