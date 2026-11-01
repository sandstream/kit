import { it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendReceiptHistory,
  MAX_RECEIPT_BYTES,
  openReceiptForRead,
} from "./review-receipt-files.js";

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
    appendReceiptHistory(path, "three\n", { noFollowFlag: 0 });
    assert.equal(readReceipt(path), "one\ntwo\nthree\n");
  });
});

it("checks the opened file size before appending", () => {
  withDirectory((dir) => {
    const path = join(dir, "history");
    writeFileSync(path, Buffer.alloc(MAX_RECEIPT_BYTES - 2, 65));
    assert.throws(
      () =>
        appendReceiptHistory(path, "xy", {
          afterOpen: () => appendFileSync(path, "z"),
        }),
      /history.*size limit/i,
    );
    const data = readFileSync(path);
    assert.equal(data.length, MAX_RECEIPT_BYTES - 1);
    assert.equal(data.subarray(-1).toString(), "z");
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
      assert.throws(() => appendReceiptHistory(link, "write", { noFollowFlag: noFollow }));
      assert.equal(readFileSync(target, "utf8"), "unchanged");
    });
  });
}

it("preserves a replaced temporary file if publication fails", (t) => {
  withDirectory((dir) => {
    const history = join(dir, "history");
    const original = join(dir, "original");
    let temp = "";
    let cannotRename = false;
    let failure: unknown;
    try {
      appendReceiptHistory(history, "entry", {
        publish: (source) => {
          temp = String(source);
          try {
            renameSync(temp, original);
          } catch (error) {
            if (
              process.platform === "win32" &&
              ["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")
            )
              cannotRename = true;
            throw error;
          }
          writeFileSync(temp, "replacement");
          throw new Error("publication failed");
        },
      });
    } catch (error) {
      failure = error;
    }
    if (cannotRename) {
      t.skip("Windows cannot rename an open file in this test environment");
      return;
    }
    assert.ok(failure);
    assert.equal(existsSync(history), false);
    assert.equal(readFileSync(original, "utf8"), "");
    assert.equal(readFileSync(temp, "utf8"), "replacement");
  });
});

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
    assert.throws(() => appendReceiptHistory(link, "write", { noFollowFlag: 0 }));
    assert.equal(existsSync(target), false);
    assert.deepEqual(readdirSync(dir), ["history"]);
  });
});

it("cannot publish a hard link over a dangling symbolic link", (t) => {
  withDirectory((dir) => {
    const target = join(dir, "missing-target");
    const link = join(dir, "history");
    const temp = join(dir, "temp");
    writeFileSync(temp, "unchanged");
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
    assert.throws(() => linkSync(temp, link));
    assert.equal(existsSync(target), false);
    assert.equal(readFileSync(temp, "utf8"), "unchanged");
  });
});

it("removes the temporary file and preserves a hard link failure", () => {
  withDirectory((dir) => {
    const path = join(dir, "history");
    const failure = Object.assign(new Error("hard links unavailable"), { code: "ENOTSUP" });
    assert.throws(
      () =>
        appendReceiptHistory(path, "entry", {
          publish: () => {
            throw failure;
          },
        }),
      (error) => error === failure,
    );
    assert.equal(existsSync(path), false);
    assert.deepEqual(readdirSync(dir), []);
  });
});

it("does not modify history created by another process during publication", () => {
  withDirectory((dir) => {
    const path = join(dir, "history");
    assert.throws(
      () =>
        appendReceiptHistory(path, "entry", {
          publish: (source, destination) => {
            writeFileSync(destination, "other process");
            linkSync(source, destination);
          },
        }),
      /review history changed while creating it; retry the operation/,
    );
    assert.equal(readFileSync(path, "utf8"), "other process");
    assert.deepEqual(readdirSync(dir), ["history"]);
  });
});

for (const noFollow of [undefined, 0]) {
  it(`does not delete or write a replaced temporary file with no-follow mode ${String(noFollow)}`, (t) => {
    withDirectory((dir) => {
      const history = join(dir, "history");
      const original = join(dir, "original");
      let temp = "";
      let cannotRename = false;
      let failure: unknown;
      try {
        appendReceiptHistory(history, "entry", {
          noFollowFlag: noFollow,
          publish: (source, destination) => {
            temp = String(source);
            try {
              renameSync(temp, original);
            } catch (error) {
              if (
                process.platform === "win32" &&
                ["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")
              )
                cannotRename = true;
              throw error;
            }
            writeFileSync(temp, "replacement");
            linkSync(temp, destination);
          },
        });
      } catch (error) {
        failure = error;
      }
      if (cannotRename) {
        t.skip("Windows cannot rename an open file in this test environment");
        return;
      }
      assert.ok(failure);
      assert.equal(readFileSync(original, "utf8"), "");
      assert.equal(readFileSync(temp, "utf8"), "replacement");
      assert.equal(readFileSync(history, "utf8"), "replacement");
    });
  });
}

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
        assert.throws(() =>
          appendReceiptHistory(path, "write", { noFollowFlag: 0, afterOpen: swap }),
        );
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
