import { it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendReceiptHistory, openReceiptForRead } from "./review-receipt-files.js";

function withDirectory(test: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "kit-receipt-files-"));
  try {
    test(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function readReceipt(path: string, flag?: number): string {
  const fd = openReceiptForRead(path, flag);
  try {
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

it("creates and appends regular history, then reads it through a descriptor", () => {
  withDirectory((dir) => {
    const path = join(dir, "history");
    appendReceiptHistory(path, "one\n");
    appendReceiptHistory(path, "two\n");
    assert.equal(readReceipt(path), "one\ntwo\n");
    assert.equal(readReceipt(path, 0), "one\ntwo\n");
    appendReceiptHistory(path, "three\n", 0);
    assert.equal(readReceipt(path), "one\ntwo\nthree\n");
  });
});

it("reports a missing receipt without creating it", () => {
  withDirectory((dir) => {
    const path = join(dir, "missing");
    assert.throws(() => openReceiptForRead(path), { code: "ENOENT" });
    assert.equal(existsSync(path), false);
  });
});

for (const noFollow of [undefined, 0]) {
  it(`refuses a symbolic link with no-follow mode ${String(noFollow)}`, (t) => {
    withDirectory((dir) => {
      const target = join(dir, "target");
      const link = join(dir, "history");
      writeFileSync(target, "unchanged");
      try {
        symlinkSync(target, link);
      } catch (error) {
        if (
          process.platform === "win32" &&
          ["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")
        ) {
          t.skip("Windows cannot create symbolic links in this test environment");
          return;
        }
        throw error;
      }
      assert.throws(() => readReceipt(link, noFollow));
      assert.throws(() => appendReceiptHistory(link, "write", noFollow));
      assert.equal(readFileSync(target, "utf8"), "unchanged");
    });
  });
}

it("does not create the target of a dangling symbolic link", (t) => {
  withDirectory((dir) => {
    const target = join(dir, "missing-target");
    const link = join(dir, "history");
    try {
      symlinkSync(target, link);
    } catch (error) {
      if (
        process.platform === "win32" &&
        ["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")
      ) {
        t.skip("Windows cannot create symbolic links in this test environment");
        return;
      }
      throw error;
    }
    assert.throws(() => readReceipt(link, 0));
    assert.throws(() => appendReceiptHistory(link, "write", 0));
    assert.equal(existsSync(target), false);
  });
});

for (const action of ["read", "append"] as const) {
  it(`rejects a replaced link before ${action} in the Windows fallback`, (t) => {
    withDirectory((dir) => {
      const path = join(dir, "history");
      const old = join(dir, "old");
      const target = join(dir, "target");
      const probe = join(dir, "probe");
      writeFileSync(path, "original");
      writeFileSync(target, "unchanged");
      try {
        symlinkSync(target, probe);
        unlinkSync(probe);
      } catch (error) {
        if (
          process.platform === "win32" &&
          ["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")
        ) {
          t.skip("Windows cannot create symbolic links in this test environment");
          return;
        }
        throw error;
      }
      const swap = () => {
        renameSync(path, old);
        symlinkSync(target, path);
      };
      if (action === "read") {
        assert.throws(() => openReceiptForRead(path, 0, swap));
      } else {
        assert.throws(() => appendReceiptHistory(path, "write", 0, swap));
      }
      assert.equal(readFileSync(old, "utf8"), "original");
      assert.equal(readFileSync(target, "utf8"), "unchanged");
    });
  });
}

it("refuses hard links before reading or appending", () => {
  withDirectory((dir) => {
    const target = join(dir, "target");
    const link = join(dir, "history");
    writeFileSync(target, "unchanged");
    linkSync(target, link);
    assert.throws(() => readReceipt(link));
    assert.throws(() => appendReceiptHistory(link, "write"));
    assert.equal(readFileSync(target, "utf8"), "unchanged");
  });
});

it("refuses a directory before reading or appending", () => {
  withDirectory((dir) => {
    const path = join(dir, "history");
    mkdirSync(path);
    assert.throws(() => readReceipt(path));
    assert.throws(() => appendReceiptHistory(path, "write"));
  });
});

it("does not block on a FIFO", (t) => {
  if (process.platform === "win32") {
    t.skip("FIFO files are not available on Windows");
    return;
  }
  withDirectory((dir) => {
    const path = join(dir, "history");
    const make = spawnSync("mkfifo", [path]);
    if (make.error && (make.error as NodeJS.ErrnoException).code === "ENOENT") {
      t.skip("mkfifo is not available");
      return;
    }
    assert.equal(make.status, 0);
    const moduleUrl = new URL("./review-receipt-files.js", import.meta.url).href;
    const code =
      `import {openReceiptForRead,appendReceiptHistory} from ${JSON.stringify(moduleUrl)};\n` +
      `for (const op of [() => openReceiptForRead(${JSON.stringify(path)}), () => appendReceiptHistory(${JSON.stringify(path)}, "x")]) {\n` +
      `  try { op(); process.exit(2); } catch {}\n` +
      `}`;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(child.error, undefined, "FIFO operation timed out");
    assert.equal(child.status, 0, child.stderr);
  });
});
