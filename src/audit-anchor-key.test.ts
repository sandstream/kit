import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { getAuditAnchorKeyAt } from "./audit-anchor-key.js";

it("creates one guarded key and reads the same key on later calls", async () => {
  const root = mkdtempSync(join(tmpdir(), "kit-anchor-key-"));
  try {
    const directory = join(root, "private");
    const path = join(directory, "key");
    let guardCalls = 0;
    const guard = () => {
      guardCalls++;
    };
    const created = await getAuditAnchorKeyAt(path, directory, guard);
    const loaded = await getAuditAnchorKeyAt(path, directory, guard);
    assert.equal(created.length, 32);
    assert.deepEqual(loaded, created);
    assert.equal(readFileSync(path, "utf8").trim(), created.toString("hex"));
    assert.ok(guardCalls > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("does not rewrite an insecure existing key in guarded mode", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX permission test");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "kit-anchor-key-perms-"));
  try {
    const path = join(root, "key");
    const contents = "ab".repeat(32) + "\n";
    writeFileSync(path, contents, { mode: 0o600 });
    chmodSync(path, 0o644);
    await assert.rejects(
      getAuditAnchorKeyAt(path, root, () => {}),
      /not a private regular file/,
    );
    assert.equal(readFileSync(path, "utf8"), contents);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
