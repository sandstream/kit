import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs, {
  rmSync,
  readFileSync,
  writeFileSync,
  statSync,
  chmodSync,
  existsSync,
  readdirSync,
  symlinkSync,
  linkSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { it, type TestContext } from "node:test";
import { openMemoryDb, upsertSession, insertMessage } from "./db.js";
import {
  fixture,
  closedSource,
  modes,
  passphrase,
  keypair,
  racingBackup,
  restoreMocks,
} from "./backup.test-support.js";

function aliasPath(input: string, kind: string): string {
  if (kind === "same") return input;
  if (kind === "relative") return `${dirname(input)}/./${basename(input)}`;
  const path = `${input}.${kind}`;
  if (kind === "hardlink") linkSync(input, path);
  else if (kind === "parent-symlink") {
    symlinkSync(dirname(input), path, "junction");
    return join(path, basename(input));
  } else symlinkSync(input, path);
  return path;
}

const aliases =
  process.platform === "win32"
    ? ["same", "relative", "hardlink"]
    : ["same", "relative", "hardlink", "symlink", "parent-symlink"];

function observeCapture(t: TestContext, dir: string, src: string, blob: string, fault: string) {
  const dirs: string[] = [];
  const files: string[] = [];
  const handles = new Set<DatabaseSync>();
  const makeTemp = fs.mkdtempSync;
  const writeFile = fs.writeFileSync;
  const readFile = fs.readFileSync;
  const read = fs.readSync;
  const open = fs.openSync;
  const close = fs.closeSync;
  const prepare = DatabaseSync.prototype.prepare;
  const rename = fs.renameSync;
  const snapshotDescriptors = new Set<number>();
  const publicationPath = fs.realpathSync(blob);
  t.mock.method(fs, "mkdtempSync", (prefix: string) => {
    const path = makeTemp(join(dir, basename(prefix)));
    dirs.push(path);
    if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o700);
    if (fault === "open") rmSync(src);
    return path;
  });
  t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof writeFile>) => {
    const path = args[0];
    if (typeof path === "string" && dirs.includes(dirname(path))) {
      if (fault === "create") throw new Error("injected create failure");
      writeFile(...args);
      files.push(path);
      if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
      // SQLite itself rejects the nonempty export destination.
      if (fault === "export") writeFile(path, readFile(src));
      return;
    }
    if (path === blob && fault === "output") throw new Error("injected output failure");
    writeFile(...args);
  });
  t.mock.method(fs, "readFileSync", (...args: Parameters<typeof readFile>) => {
    const path = args[0];
    if (typeof path === "string" && files.includes(path)) {
      if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
      if (fault === "read") throw new Error("injected read failure");
    }
    return readFile(...args);
  });
  t.mock.method(fs, "openSync", (...args: Parameters<typeof open>) => {
    const fd = open(...args);
    if (args[1] === "r" && typeof args[0] === "string" && files.includes(args[0])) {
      snapshotDescriptors.add(fd);
    }
    return fd;
  });
  t.mock.method(fs, "readSync", (...args: Parameters<typeof read>) => {
    if (snapshotDescriptors.has(args[0]) && fault === "read") {
      throw new Error("injected read failure");
    }
    return read(...args);
  });
  t.mock.method(fs, "closeSync", (...args: Parameters<typeof close>) => {
    snapshotDescriptors.delete(args[0]);
    return close(...args);
  });
  // Observe handle lifetime without replacing any SQLite operation or result.
  t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
    handles.add(this);
    return prepare.call(this, sql);
  });
  t.mock.method(fs, "renameSync", (...args: Parameters<typeof rename>) => {
    if (args[1] === publicationPath && fault === "output")
      throw new Error("injected output failure");
    return rename(...args);
  });
  syncBuiltinESMExports();
  return { dirs, files, handles };
}

for (const mode of modes) {
  it(`${mode.name}: retains committed WAL rows while an older reader pins the checkpoint`, (t) => {
    const f = fixture(t);
    const writer = f.track(openMemoryDb(f.src));
    writer.exec("PRAGMA wal_autocheckpoint = 0; PRAGMA busy_timeout = 0");
    upsertSession(writer, { sessionId: "snapshot-session", harness: "codex" });
    insertMessage(writer, {
      uuid: "baseline",
      sessionId: "snapshot-session",
      type: "user",
      content: "checkpointed message",
    });
    writer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const reader = f.track(new DatabaseSync(f.src, { readOnly: true }));
    reader.exec("BEGIN; SELECT * FROM messages");
    insertMessage(writer, {
      uuid: "wal-only",
      sessionId: "snapshot-session",
      type: "user",
      content: "committed while reader is open",
    });
    const checkpoint = writer.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    assert.equal(checkpoint?.busy, 1, "real SQLite reader prevents a complete checkpoint");
    assert.ok(Number(checkpoint?.log) > Number(checkpoint?.checkpointed));

    mode.backup(f.src, f.blob);
    mode.restore(f.blob, f.dest);
    const restored = f.track(new DatabaseSync(f.dest, { readOnly: true }));
    assert.equal(restored.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
    assert.deepEqual(
      restored
        .prepare("SELECT uuid, content FROM messages ORDER BY uuid")
        .all()
        .map((r) => ({ ...r })),
      [
        { uuid: "baseline", content: "checkpointed message" },
        { uuid: "wal-only", content: "committed while reader is open" },
      ],
    );
    assert.deepEqual(
      restored
        .prepare(
          `SELECT m.uuid FROM messages_fts
        JOIN messages m ON m.id = messages_fts.rowid
        WHERE messages_fts MATCH 'committed'`,
        )
        .all()
        .map((row) => row.uuid),
      ["wal-only"],
      "snapshot preserves the FTS row references for committed WAL content",
    );
  });

  it(`${mode.name}: cannot mix transactions when a writer checkpoints during the file read`, (t) => {
    const f = fixture(t);
    const writer = f.track(openMemoryDb(f.src));
    writer.exec(`CREATE TABLE snapshot_rows (id INTEGER PRIMARY KEY, generation INTEGER, payload TEXT);
      WITH RECURSIVE ids(id) AS (SELECT 1 UNION ALL SELECT id + 1 FROM ids WHERE id < 768)
      INSERT INTO snapshot_rows SELECT id, 0, hex(zeroblob(2048)) FROM ids`);
    writer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const source = import.meta.url.endsWith(".ts");
    const output = execFileSync(
      process.execPath,
      [
        ...(source ? ["--import", import.meta.resolve("tsx")] : []),
        "--input-type=module",
        "-e",
        racingBackup,
        new URL(source ? "./backup.ts" : "./backup.js", import.meta.url).href,
        mode.name,
        mode.name === "passphrase" ? passphrase : keypair.publicKey,
        f.src,
        f.blob,
      ],
      { encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"] },
    );
    assert.equal(JSON.parse(output).raced, true, "writer committed between actual file reads");
    assert.equal(
      writer.prepare("SELECT MIN(generation) AS generation FROM snapshot_rows").get()?.generation,
      1,
    );
    mode.restore(f.blob, f.dest);
    const restored = f.track(new DatabaseSync(f.dest, { readOnly: true }));
    assert.equal(restored.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
    assert.deepEqual(
      {
        ...restored
          .prepare(
            "SELECT COUNT(*) AS rows, MIN(generation) AS first, MAX(generation) AS last FROM snapshot_rows",
          )
          .get(),
      },
      { rows: 768, first: 0, last: 0 },
      "snapshot started before the writer: every row must retain the earlier generation",
    );
  });

  it(`${mode.name}: rejects backup output aliasing its source`, (t) => {
    const f = fixture(t);
    closedSource(f.src);
    const before = readFileSync(f.src);
    for (const kind of aliases) {
      assert.throws(() => mode.backup(f.src, aliasPath(f.src, kind)), /different|alias/i, kind);
      assert.deepEqual(readFileSync(f.src), before, kind);
    }
  });

  it(`${mode.name}: rejects restore output aliasing its encrypted input`, (t) => {
    const f = fixture(t);
    closedSource(f.src);
    mode.backup(f.src, f.blob);
    const before = readFileSync(f.blob);
    for (const kind of aliases) {
      assert.throws(() => mode.restore(f.blob, aliasPath(f.blob, kind)), /different|alias/i, kind);
      assert.deepEqual(readFileSync(f.blob), before, kind);
    }
  });

  it(`${mode.name}: rejects existing and future SQLite sidecar aliases`, (t) => {
    const f = fixture(t);
    const db = f.track(new DatabaseSync(f.src));
    db.exec("PRAGMA journal_mode = WAL; CREATE TABLE original (id INTEGER PRIMARY KEY)");
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      const sidecar = f.src + suffix;
      const before = existsSync(sidecar) ? readFileSync(sidecar) : undefined;
      for (const kind of aliases.filter((kind) => before || kind !== "hardlink")) {
        assert.throws(() => mode.backup(f.src, aliasPath(sidecar, kind)), /different|alias/i);
        if (before) assert.deepEqual(readFileSync(sidecar), before);
        else assert.equal(existsSync(sidecar), false, "must not create a reserved sidecar");
      }
    }
    assert.equal(db.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
  });

  it(`${mode.name}: exports a read-only legacy schema without migrating the source`, (t) => {
    const f = fixture(t);
    closedSource(f.src);
    chmodSync(f.src, 0o444);
    const before = readFileSync(f.src);
    const metadata = statSync(f.src);
    mode.backup(f.src, f.blob);
    mode.restore(f.blob, f.dest);
    assert.deepEqual(readFileSync(f.src), before);
    assert.equal(statSync(f.src).mode, metadata.mode);
    assert.equal(statSync(f.src).mtimeMs, metadata.mtimeMs);
    const restored = f.track(new DatabaseSync(f.dest, { readOnly: true }));
    assert.deepEqual(
      restored
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
        .all()
        .map((r) => r.name),
      ["original", "schema_meta"],
    );
    assert.deepEqual(
      { ...restored.prepare("SELECT * FROM original").get() },
      { id: 7, content: "preserved" },
    );
    assert.equal(restored.prepare("SELECT version FROM schema_meta").get()?.version, 1);
    assert.equal(restored.prepare("PRAGMA user_version").get()?.user_version, 19);
  });

  it(`${mode.name}: excludes an active writer's uncommitted changes without waiting for its lock`, (t) => {
    const f = fixture(t);
    closedSource(f.src);
    const writer = f.track(new DatabaseSync(f.src));
    writer.exec(
      "PRAGMA journal_mode = WAL; BEGIN IMMEDIATE; UPDATE original SET content = 'uncommitted'",
    );
    mode.backup(f.src, f.blob);
    mode.restore(f.blob, f.dest);
    const restored = f.track(new DatabaseSync(f.dest, { readOnly: true }));
    assert.equal(restored.prepare("SELECT content FROM original").get()?.content, "preserved");
    assert.equal(writer.prepare("SELECT content FROM original").get()?.content, "uncommitted");
  });

  it(`${mode.name}: a missing source is not created and existing output survives`, (t) => {
    const f = fixture(t);
    writeFileSync(f.blob, "previous backup");
    assert.throws(() => mode.backup(f.src, f.blob), /ENOENT|unable to open/);
    assert.equal(existsSync(f.src), false);
    assert.equal(readFileSync(f.blob, "utf8"), "previous backup");
    assert.deepEqual(readdirSync(f.dir), ["backup.enc"]);
  });

  for (const fault of ["success", "create", "open", "export", "read", "output"]) {
    it(`${mode.name}: private snapshot cleanup and closed handles after ${fault}`, (t) => {
      const f = fixture(t);
      closedSource(f.src);
      writeFileSync(f.blob, "previous backup");
      const observed = observeCapture(t, f.dir, f.src, f.blob, fault);
      try {
        if (fault === "success") mode.backup(f.src, f.blob);
        else {
          const expected =
            fault === "export"
              ? /output file already exists/
              : fault === "open"
                ? /unable to open/
                : new RegExp(`injected ${fault} failure`);
          assert.throws(() => mode.backup(f.src, f.blob), expected);
        }
      } finally {
        restoreMocks(t);
      }
      assert.equal(observed.dirs.length, 1, "capture owns one private temporary directory");
      for (const path of [...observed.dirs, ...observed.files])
        assert.equal(existsSync(path), false);
      assert.equal(observed.handles.size, ["create", "open"].includes(fault) ? 0 : 1);
      for (const handle of observed.handles) assert.equal(handle.isOpen, false);
      if (fault === "success") {
        mode.restore(f.blob, f.dest);
        const restored = f.track(new DatabaseSync(f.dest, { readOnly: true }));
        assert.equal(restored.prepare("SELECT content FROM original").get()?.content, "preserved");
      } else assert.equal(readFileSync(f.blob, "utf8"), "previous backup");
      if (fault === "open")
        assert.equal(existsSync(f.src), false, "read-only open cannot recreate source");
    });
  }
}
