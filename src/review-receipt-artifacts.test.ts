import assert from "node:assert/strict";
import {
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { assertNoRecoveryArtifacts } from "./review-receipt-artifacts.js";

function withWorktree(test: (root: string, lock: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "kit-recovery-artifacts-"));
  try {
    test(root, join(root, "git-data", "review.lock"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

it("allows unrelated files and names that only resemble a recovery artifact", () => {
  withWorktree((root, lock) => {
    for (const name of [".kit-receipt-abc.tmp", ".kit-review-receipt.json.not-a-token.tmp"]) {
      writeFileSync(join(root, name), "user data");
    }
    assert.doesNotThrow(() => assertNoRecoveryArtifacts(root, lock));
  });
});

it("reports matching temporary receipt files in sorted order and preserves their contents", () => {
  withWorktree((root, lock) => {
    const history = join(root, `.kit-receipt-${"a".repeat(32)}.tmp`);
    const receipt = join(root, `.kit-review-receipt.json.${"b".repeat(12)}.tmp`);
    writeFileSync(receipt, "receipt evidence");
    writeFileSync(history, "history evidence");
    assert.throws(
      () => assertNoRecoveryArtifacts(root, lock),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes(lock));
        assert.ok(error.message.indexOf(history) < error.message.indexOf(receipt));
        return true;
      },
    );
    assert.equal(readFileSync(history, "utf8"), "history evidence");
    assert.equal(readFileSync(receipt, "utf8"), "receipt evidence");
  });
});

it("explains an empty history file and its temporary hard link without removing either", (t) => {
  withWorktree((root, lock) => {
    const history = join(root, ".kit-review-receipt-history.jsonl");
    const temp = join(root, `.kit-receipt-${"c".repeat(32)}.tmp`);
    writeFileSync(history, "");
    try {
      linkSync(history, temp);
    } catch (error) {
      if (
        process.platform === "win32" &&
        ["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")
      ) {
        t.skip("Windows cannot create a hard link in this test environment");
        return;
      }
      throw error;
    }
    assert.throws(() => assertNoRecoveryArtifacts(root, lock), /two links to the same empty file/);
    assert.equal(existsSync(history), true);
    assert.equal(existsSync(temp), true);
  });
});

it("does not describe a nonempty linked file as an empty history artifact", (t) => {
  withWorktree((root, lock) => {
    const history = join(root, ".kit-review-receipt-history.jsonl");
    const temp = join(root, `.kit-receipt-${"d".repeat(32)}.tmp`);
    writeFileSync(history, "signed history\n");
    try {
      linkSync(history, temp);
    } catch (error) {
      if (
        process.platform === "win32" &&
        ["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")
      ) {
        t.skip("Windows cannot create a hard link in this test environment");
        return;
      }
      throw error;
    }
    assert.throws(
      () => assertNoRecoveryArtifacts(root, lock),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Preserve these files/);
        assert.doesNotMatch(error.message, /two links to the same empty file/);
        return true;
      },
    );
    assert.equal(readFileSync(history, "utf8"), "signed history\n");
  });
});

it("preserves a temporary symbolic link and does not treat it as a history hard link", (t) => {
  withWorktree((root, lock) => {
    const history = join(root, ".kit-review-receipt-history.jsonl");
    const temp = join(root, `.kit-receipt-${"e".repeat(32)}.tmp`);
    writeFileSync(history, "original");
    try {
      symlinkSync(history, temp);
    } catch (error) {
      if (
        process.platform === "win32" &&
        ["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")
      ) {
        t.skip("Windows cannot create a symbolic link in this test environment");
        return;
      }
      throw error;
    }
    assert.throws(() => assertNoRecoveryArtifacts(root, lock), /Preserve these files/);
    assert.equal(readFileSync(temp, "utf8"), "original");
    assert.equal(readFileSync(history, "utf8"), "original");
  });
});
