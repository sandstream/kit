import assert from "node:assert/strict";
import fs, {
  readFileSync,
  writeFileSync,
  chmodSync,
  readdirSync,
  statSync,
  fstatSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { it, type TestContext } from "node:test";
import {
  fixture,
  closedSource,
  modes,
  restoreMocks,
  type BackupMode,
} from "./backup.test-support.js";

function publicationData(data: unknown): data is Buffer {
  return (
    Buffer.isBuffer(data) &&
    (data.subarray(0, 6).toString() === "KITMEM" ||
      data.subarray(0, 16).toString() === "SQLite format 3\0")
  );
}

function publicationFixture(t: TestContext, mode: BackupMode, operation: string) {
  const f = fixture(t);
  closedSource(f.src);
  mode.backup(f.src, f.blob);
  const output = operation === "backup" ? f.blob : f.dest;
  const input = operation === "backup" ? f.src : f.blob;
  const previous = Buffer.from("previous complete output, preserved on failure");
  writeFileSync(output, previous);
  chmodSync(output, 0o644);
  const entries = readdirSync(f.dir).sort();
  return {
    ...f,
    output,
    input,
    previous,
    entries,
    publish: () => mode[operation === "backup" ? "backup" : "restore"](input, output),
  };
}

for (const mode of modes) {
  for (const operation of ["backup", "restore"]) {
    it(
      `${mode.name}: ${operation} publication replaces permissive output with private bytes`,
      { skip: process.platform === "win32" && "POSIX mode bits do not verify Windows ACLs" },
      (t) => {
        const f = publicationFixture(t, mode, operation);
        const writeFile = fs.writeFileSync;
        const rename = fs.renameSync;
        const modesBeforeWrite: number[] = [];
        const previousAtRename: Buffer[] = [];
        t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof writeFile>) => {
          if (publicationData(args[1])) {
            const target = args[0];
            modesBeforeWrite.push(
              (typeof target === "number" ? fstatSync(target) : statSync(target)).mode & 0o777,
            );
          }
          writeFile(...args);
        });
        t.mock.method(fs, "renameSync", (...args: Parameters<typeof rename>) => {
          previousAtRename.push(readFileSync(f.output));
          assert.equal(statSync(args[0]).mode & 0o777, 0o600, "private before publication");
          return rename(...args);
        });
        syncBuiltinESMExports();
        try {
          f.publish();
        } finally {
          restoreMocks(t);
        }
        assert.ok(modesBeforeWrite.length > 0, "publication writes observable data");
        assert.deepEqual(
          [...new Set(modesBeforeWrite)],
          [0o600],
          "every observed staging file is 0600 before data",
        );
        assert.deepEqual(
          previousAtRename,
          [f.previous],
          "old output survives until atomic publication",
        );
        assert.equal(statSync(f.output).mode & 0o777, 0o600);
        assert.deepEqual(readdirSync(f.dir).sort(), f.entries, "no staging file remains");
        if (operation === "backup") mode.restore(f.blob, f.dest);
        const restored = f.track(new DatabaseSync(f.dest, { readOnly: true }));
        assert.equal(restored.prepare("SELECT content FROM original").get()?.content, "preserved");
      },
    );

    it(`${mode.name}: ${operation} publication preserves previous bytes after a partial write`, (t) => {
      const f = publicationFixture(t, mode, operation);
      const writeFile = fs.writeFileSync;
      const descriptors: number[] = [];
      let injected = false;
      t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof writeFile>) => {
        if (publicationData(args[1])) {
          injected = true;
          if (typeof args[0] === "number") descriptors.push(args[0]);
          writeFile(args[0], args[1].subarray(0, 32), args[2]);
          throw new Error("injected partial publication write");
        }
        writeFile(...args);
      });
      syncBuiltinESMExports();
      try {
        assert.throws(f.publish, /injected partial publication write/);
      } finally {
        restoreMocks(t);
      }
      assert.equal(injected, true);
      assert.deepEqual(readFileSync(f.output), f.previous);
      if (process.platform !== "win32") assert.equal(statSync(f.output).mode & 0o777, 0o644);
      for (const fd of descriptors) assert.throws(() => fstatSync(fd), { code: "EBADF" });
      assert.deepEqual(readdirSync(f.dir).sort(), f.entries, "partial staging file is removed");
    });

    it(`${mode.name}: ${operation} publication preserves previous bytes when rename fails`, (t) => {
      const f = publicationFixture(t, mode, operation);
      let attempted = false;
      t.mock.method(fs, "renameSync", () => {
        attempted = true;
        throw new Error("injected publication rename failure");
      });
      syncBuiltinESMExports();
      try {
        assert.throws(f.publish, /injected publication rename failure/);
      } finally {
        restoreMocks(t);
      }
      assert.equal(attempted, true);
      assert.deepEqual(readFileSync(f.output), f.previous);
      assert.deepEqual(readdirSync(f.dir).sort(), f.entries, "unpublished staging file is removed");
    });
  }

  it(
    `${mode.name}: restore publication is exactly 0600 under a restrictive umask`,
    { skip: process.platform === "win32" && "POSIX mode bits do not verify Windows ACLs" },
    (t) => {
      const f = publicationFixture(t, mode, "restore");
      const writeFile = fs.writeFileSync;
      let observed = false;
      t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof writeFile>) => {
        if (publicationData(args[1])) {
          observed = true;
          const target = args[0];
          assert.equal(
            (typeof target === "number" ? fstatSync(target) : statSync(target)).mode & 0o777,
            0o600,
            "exact permissions before plaintext, even when umask masks owner access",
          );
        }
        writeFile(...args);
      });
      syncBuiltinESMExports();
      const previousMask = process.umask(0o777);
      try {
        f.publish();
      } finally {
        process.umask(previousMask);
        restoreMocks(t);
      }
      assert.equal(observed, true);
      assert.equal(statSync(f.output).mode & 0o777, 0o600);
      assert.deepEqual(readdirSync(f.dir).sort(), f.entries);
      const restored = f.track(new DatabaseSync(f.dest, { readOnly: true }));
      assert.equal(restored.prepare("SELECT content FROM original").get()?.content, "preserved");
    },
  );

  it(`${mode.name}: restore publication writes no plaintext when setting private mode fails`, (t) => {
    const f = publicationFixture(t, mode, "restore");
    const writeFile = fs.writeFileSync;
    const descriptors: number[] = [];
    let wrotePlaintext = false;
    t.mock.method(fs, "fchmodSync", (fd: number) => {
      descriptors.push(fd);
      throw new Error("injected private mode failure");
    });
    t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof writeFile>) => {
      if (publicationData(args[1])) wrotePlaintext = true;
      writeFile(...args);
    });
    syncBuiltinESMExports();
    try {
      assert.throws(f.publish, /injected private mode failure/);
    } finally {
      restoreMocks(t);
    }
    assert.equal(wrotePlaintext, false);
    assert.equal(descriptors.length, 1);
    for (const fd of descriptors) assert.throws(() => fstatSync(fd), { code: "EBADF" });
    assert.deepEqual(readFileSync(f.output), f.previous);
    assert.deepEqual(readdirSync(f.dir).sort(), f.entries);
  });
}
