import assert from "node:assert/strict";
import { it } from "node:test";
import { linkSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishReviewReceipt } from "./review-receipt-publish.js";

function inDirectory(test: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "kit-receipt-publish-"));
  try {
    test(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

it("publishes and replaces a receipt with the exact bytes", () => {
  inDirectory((root) => {
    const path = publishReviewReceipt(root, "first\n");
    assert.equal(readFileSync(path, "utf8"), "first\n");
    assert.equal(publishReviewReceipt(root, "second\n"), path);
    assert.equal(readFileSync(path, "utf8"), "second\n");
  });
});

for (const throwAfterSwap of [false, true]) {
  it(`preserves a replaced temporary file when the callback ${throwAfterSwap ? "throws" : "returns"}`, () => {
    inDirectory((root) => {
      const path = join(root, ".kit-review-receipt.json");
      const moved = join(root, "moved");
      let temp = "";
      writeFileSync(path, "previous");
      assert.throws(() =>
        publishReviewReceipt(root, "new", {
          afterTempWrite: (name) => {
            temp = name;
            renameSync(name, moved);
            writeFileSync(name, "other user's file");
            if (throwAfterSwap) throw new Error("callback failed");
          },
        }),
      );
      assert.equal(readFileSync(path, "utf8"), "previous");
      assert.equal(readFileSync(temp, "utf8"), "other user's file");
      assert.equal(readFileSync(moved, "utf8"), "new");
    });
  });
}

it("preserves a destination replaced before publication", () => {
  inDirectory((root) => {
    const path = join(root, ".kit-review-receipt.json");
    const moved = join(root, "old-receipt");
    writeFileSync(path, "previous");
    assert.throws(() =>
      publishReviewReceipt(root, "new", {
        afterTempWrite: () => {
          renameSync(path, moved);
          writeFileSync(path, "other user's file");
        },
      }),
    );
    assert.equal(readFileSync(path, "utf8"), "other user's file");
    assert.equal(readFileSync(moved, "utf8"), "previous");
  });
});

it("preserves a destination changed in place without changing its length", () => {
  inDirectory((root) => {
    const path = join(root, ".kit-review-receipt.json");
    writeFileSync(path, "previous");
    assert.throws(() =>
      publishReviewReceipt(root, "new", {
        afterTempWrite: () => writeFileSync(path, "intruder"),
      }),
    );
    assert.equal(readFileSync(path, "utf8"), "intruder");
  });
});

it("does not replace the receipt when the staged bytes change in place", () => {
  inDirectory((root) => {
    const path = join(root, ".kit-review-receipt.json");
    let staged = "";
    writeFileSync(path, "previous");
    assert.throws(() =>
      publishReviewReceipt(root, "new", {
        afterTempWrite: (temp) => {
          staged = temp;
          writeFileSync(temp, "bad");
        },
      }),
    );
    assert.equal(readFileSync(path, "utf8"), "previous");
    assert.equal(readFileSync(staged, "utf8"), "bad");
  });
});

it("preserves a newly hard-linked staged file", () => {
  inDirectory((root) => {
    const path = join(root, ".kit-review-receipt.json");
    const alias = join(root, "other");
    writeFileSync(path, "previous");
    assert.throws(() =>
      publishReviewReceipt(root, "new", { afterTempWrite: (temp) => linkSync(temp, alias) }),
    );
    assert.equal(readFileSync(path, "utf8"), "previous");
    assert.equal(readFileSync(alias, "utf8"), "new");
  });
});
