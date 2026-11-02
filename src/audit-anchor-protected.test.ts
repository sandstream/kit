import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { getAuditAnchorKey, tryReadProtectedAuditAnchorKey } from "./audit-anchor.js";

it("refuses a readable-by-others existing key without changing it", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX permission test");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "kit-anchor-permissions-"));
  try {
    const path = join(dir, "audit-anchor.key");
    const contents = "ab".repeat(32) + "\n";
    writeFileSync(path, contents, { mode: 0o600 });
    chmodSync(path, 0o644);
    assert.equal((await getAuditAnchorKey(dir)).toString("hex"), contents.trim());
    await assert.rejects(
      getAuditAnchorKey(dir, () => {}),
      /not a private regular file/,
    );
    await assert.rejects(tryReadProtectedAuditAnchorKey(dir), /not a private regular file/);
    assert.equal(readFileSync(path, "utf8"), contents);
    chmodSync(path, 0o600);
    assert.equal((await getAuditAnchorKey(dir, () => {})).toString("hex"), contents.trim());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("rejects a hard-linked existing key without changing either name", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kit-anchor-hardlink-"));
  try {
    const source = join(dir, "source"),
      path = join(dir, "audit-anchor.key");
    const contents = "cd".repeat(32) + "\n";
    writeFileSync(source, contents, { mode: 0o600 });
    linkSync(source, path);
    await assert.rejects(
      getAuditAnchorKey(dir, () => {}),
      /multiple links/,
    );
    assert.equal(readFileSync(source, "utf8"), contents);
    assert.equal(readFileSync(path, "utf8"), contents);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("rejects a symbolic-link key without changing its target", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "kit-anchor-symlink-"));
  try {
    const target = join(dir, "target"),
      path = join(dir, "audit-anchor.key");
    const contents = "ef".repeat(32) + "\n";
    writeFileSync(target, contents, { mode: 0o600 });
    try {
      symlinkSync(target, path);
    } catch (error) {
      if (
        process.platform === "win32" &&
        ["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")
      ) {
        t.skip("Windows symbolic links are unavailable");
        return;
      }
      throw error;
    }
    await assert.rejects(
      getAuditAnchorKey(dir, () => {}),
      /Cannot safely open|not a private regular file/,
    );
    assert.equal(readFileSync(target, "utf8"), contents);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("does not create the target of a dangling key symlink", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "kit-anchor-dangling-"));
  try {
    const target = join(dir, "missing"),
      path = join(dir, "audit-anchor.key");
    try {
      symlinkSync(target, path);
    } catch (error) {
      if (
        process.platform === "win32" &&
        ["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")
      ) {
        t.skip("Windows symbolic links are unavailable");
        return;
      }
      throw error;
    }
    await assert.rejects(getAuditAnchorKey(dir, () => {}));
    assert.equal(existsSync(target), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("does not write key material when Windows ACL setup is unavailable", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows ACL test");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "kit-anchor-acl-failure-"));
  const previousSystemRoot = process.env.SystemRoot;
  const previousWindir = process.env.WINDIR;
  try {
    delete process.env.SystemRoot;
    delete process.env.WINDIR;
    await assert.rejects(
      getAuditAnchorKey(dir, () => {}),
      /Cannot establish Windows ACL/,
    );
    assert.equal(existsSync(join(dir, "audit-anchor.key")), false);
    const temp = readdirSync(dir).find((name) =>
      /^\.kit-audit-anchor-[a-f0-9]{32}\.tmp$/.test(name),
    );
    assert.ok(temp);
    assert.equal(readFileSync(join(dir, temp)).length, 0);
  } finally {
    if (previousSystemRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = previousSystemRoot;
    if (previousWindir === undefined) delete process.env.WINDIR;
    else process.env.WINDIR = previousWindir;
    rmSync(dir, { recursive: true, force: true });
  }
});
