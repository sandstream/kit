import assert from "node:assert/strict";
import fs, {
  existsSync,
  fstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { it, type TestContext } from "node:test";
import { isAsymmetricBackup, isEncryptedBackup } from "./backup.js";

function fixture(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-backup-format-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "input");
}

type Inspection = () => boolean;
type InspectionOptions = { maxReadBytes?: number; failAfterRead?: boolean };

function observeInspection(t: TestContext, inspect: Inspection, options: InspectionOptions = {}) {
  const readFile = fs.readFileSync;
  const read = fs.readSync;
  const open = fs.openSync;
  const descriptors: number[] = [];
  let bytes = 0;
  let readingFile = false;
  // Delegate every operation to disk; do not count readFileSync's nested reads twice.
  t.mock.method(fs, "readFileSync", (...args: Parameters<typeof readFile>) => {
    readingFile = true;
    try {
      const data = readFile(...args);
      bytes += Buffer.byteLength(data);
      return data;
    } finally {
      readingFile = false;
    }
  });
  t.mock.method(
    fs,
    "readSync",
    (
      fd: number,
      buffer: NodeJS.ArrayBufferView,
      offset: number | fs.ReadOptions = {},
      length?: number,
      position: number | bigint | null = null,
    ) => {
      const readOptions = typeof offset === "number" ? { offset, length, position } : offset;
      const count = read(fd, buffer, {
        ...readOptions,
        length: Math.min(
          readOptions.length ?? buffer.byteLength - (readOptions.offset ?? 0),
          options.maxReadBytes ?? Infinity,
        ),
      });
      if (!readingFile) bytes += count;
      if (options.failAfterRead) throw new Error("injected failure after a real disk read");
      return count;
    },
  );
  t.mock.method(fs, "openSync", (...args: Parameters<typeof open>) => {
    const fd = open(...args);
    descriptors.push(fd);
    return fd;
  });
  syncBuiltinESMExports();
  try {
    return { result: inspect(), bytes, descriptors };
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
}

function assertClosed(descriptors: number[]): void {
  assert.ok(descriptors.length > 0, "inspection opened a real input file");
  for (const fd of descriptors) {
    assert.throws(
      () => {
        fstatSync(fd);
      },
      { code: "EBADF" },
    );
  }
}

it("format inspection reads only the header, not an encrypted payload", (t) => {
  const path = fixture(t);
  const payload = Buffer.alloc(64 * 1024, 0xa5);
  payload.write("KITMEM03");
  writeFileSync(path, payload);

  const encrypted = observeInspection(t, () => isEncryptedBackup(path));
  const asymmetric = observeInspection(t, () => isAsymmetricBackup(path));
  t.diagnostic(`bytes read: encrypted=${encrypted.bytes}, asymmetric=${asymmetric.bytes}`);
  assert.equal(encrypted.result, true);
  assert.equal(asymmetric.result, true);
  assert.deepEqual(readFileSync(path), payload, "format inspection never changes source bytes");
  assert.equal(encrypted.bytes, 8);
  assert.equal(asymmetric.bytes, 8);
  assertClosed(encrypted.descriptors);
  assertClosed(asymmetric.descriptors);
});

it("format inspection assembles a complete header across short disk reads", (t) => {
  const path = fixture(t);
  const payload = Buffer.from("KITMEM03body remains unread");
  writeFileSync(path, payload);

  for (const inspect of [isEncryptedBackup, isAsymmetricBackup]) {
    const observed = observeInspection(t, () => inspect(path), { maxReadBytes: 3 });
    assertClosed(observed.descriptors);
    assert.equal(observed.result, true);
    assert.equal(observed.bytes, 8);
  }
  assert.deepEqual(readFileSync(path), payload);
});

it("format inspection rejects a raw SQLite database without reading its payload", (t) => {
  const path = fixture(t);
  const db = new DatabaseSync(path);
  try {
    db.exec("CREATE TABLE payload (value BLOB); INSERT INTO payload VALUES (zeroblob(32768))");
  } finally {
    db.close();
  }
  const original = readFileSync(path);
  for (const inspect of [isEncryptedBackup, isAsymmetricBackup]) {
    const observed = observeInspection(t, () => inspect(path));
    assert.equal(observed.result, false);
    assert.equal(observed.bytes, 8);
    assertClosed(observed.descriptors);
  }
  assert.deepEqual(readFileSync(path), original);
});

it("format inspection accepts only exact supported magic headers", (t) => {
  const path = fixture(t);
  const cases: [string, boolean, boolean][] = [
    ["KITMEM01", true, false],
    ["KITMEM02", true, false],
    ["KITMEM03", true, true],
    ["KITMEM04", true, false],
    ["KITMEM05", true, true],
    ["KITMEM06", false, false],
    ["kitmem03", false, false],
    ["KITMEM0\0", false, false],
    [" KITMEM03", false, false],
  ];
  for (const [header, encrypted, asymmetric] of cases) {
    writeFileSync(path, header);
    assert.equal(isEncryptedBackup(path), encrypted, JSON.stringify(header));
    assert.equal(isAsymmetricBackup(path), asymmetric, JSON.stringify(header));
    assert.equal(readFileSync(path, "utf8"), header);
  }
});

it("format inspection rejects every truncated header and closes the input at EOF", (t) => {
  const path = fixture(t);
  for (let length = 0; length < 8; length++) {
    const header = Buffer.from("KITMEM03").subarray(0, length);
    writeFileSync(path, header);
    for (const inspect of [isEncryptedBackup, isAsymmetricBackup]) {
      const observed = observeInspection(t, () => inspect(path), { maxReadBytes: 3 });
      assert.equal(observed.result, false, `truncated to ${length} bytes`);
      assert.equal(observed.bytes, length);
      assertClosed(observed.descriptors);
    }
    assert.deepEqual(readFileSync(path), header);
  }
});

it("format inspection returns false for missing paths and unreadable directories", (t) => {
  const path = fixture(t);
  for (const inspect of [isEncryptedBackup, isAsymmetricBackup]) {
    const missing = observeInspection(t, () => inspect(path));
    assert.equal(missing.result, false);
    assert.equal(missing.bytes, 0);
    assert.equal(missing.descriptors.length, 0);
    assert.equal(existsSync(path), false, "inspection never creates a missing input");

    const directory = observeInspection(t, () => inspect(dirname(path)));
    assert.equal(directory.result, false);
    // Some platforms reject directories during open, others during read.
    if (directory.descriptors.length) assertClosed(directory.descriptors);
  }
});

it("format inspection closes its input and returns false when a disk read fails", (t) => {
  const path = fixture(t);
  const original = Buffer.from("KITMEM03payload");
  writeFileSync(path, original);
  for (const inspect of [isEncryptedBackup, isAsymmetricBackup]) {
    const observed = observeInspection(t, () => inspect(path), {
      maxReadBytes: 3,
      failAfterRead: true,
    });
    assert.equal(observed.result, false);
    assert.equal(observed.bytes, 3, "failure occurs after opening and reading the input");
    assertClosed(observed.descriptors);
  }
  assert.deepEqual(readFileSync(path), original);
});
