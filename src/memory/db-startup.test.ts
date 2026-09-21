import { it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { openMemoryDb, SCHEMA_VERSION } from "./db.js";
import { seedLegacyPalDb } from "./pal-fixture.test-support.js";

// Exercise startup through openMemoryDb, gating real SQLite operations across processes.
// Never manufacture SQLITE_BUSY.
const WORKER = String.raw`
import { DatabaseSync } from "node:sqlite";
import { readSync, writeSync } from "node:fs";
const [moduleUrl, mode, id] = process.argv.slice(1);
const emit = (event, extra = {}) => writeSync(1, JSON.stringify({ event, ...extra }) + "\n");
const gate = (event) => {
  emit(event);
  if (readSync(0, Buffer.alloc(1), 0, 1, null) !== 1) throw new Error("gate closed");
};
if (mode === "holder") {
  const db = new DatabaseSync(process.env.KIT_MEMORY_DB);
  db.exec("BEGIN IMMEDIATE");
  db.prepare("SELECT name FROM sqlite_master").all();
  gate("locked");
  db.exec("ROLLBACK");
  db.close();
  emit("released");
} else {
  const { openMemoryDb } = await import(moduleUrl);
  const { palAdd } = await import(new URL(moduleUrl.endsWith('.ts') ? './pal.ts' : './pal.js', moduleUrl));
  const exec = DatabaseSync.prototype.exec;
  const prepare = DatabaseSync.prototype.prepare;
  let paused = false;
  let connection;
  DatabaseSync.prototype.exec = function(sql) {
    connection = this;
    try {
      return exec.call(this, sql);
    } catch (error) {
      if (mode === "wal" && /journal_mode\s*=\s*WAL/i.test(sql) && !paused) {
        paused = true;
        emit("busy", { errcode: error.errcode, message: error.message });
        if (readSync(0, Buffer.alloc(1), 0, 1, null) !== 1) throw new Error("gate closed");
      }
      throw error;
    }
  };
  DatabaseSync.prototype.prepare = function(sql) {
    const statement = prepare.call(this, sql);
    if (mode === "migration" && sql === "PRAGMA table_info(pending_actions)" && !paused) {
      const all = statement.all;
      statement.all = function(...args) {
        const rows = all.apply(this, args);
        paused = true;
        gate("inspected");
        return rows;
      };
    }
    return statement;
  };
  gate("ready");
  const started = performance.now();
  try {
    const db = openMemoryDb(undefined, { defaultClass: "restricted" });
    palAdd(db, { title: id });
    const version = db.prepare("SELECT version FROM schema_meta").all();
    const journal = db.prepare("PRAGMA journal_mode").get().journal_mode;
    const timeout = db.prepare("PRAGMA busy_timeout").get().timeout;
    db.close();
    emit("result", { ok: true, version, journal, timeout });
  } catch (error) {
    emit("result", {
      ok: false, errcode: error.errcode, message: error.message, stack: error.stack,
      elapsedMs: performance.now() - started, connectionClosed: !connection?.isOpen,
    });
  }
}
`;

interface WorkerEvent {
  event: string;
  ok?: boolean;
  errcode?: number;
  message?: string;
  version?: { version: number }[];
  journal?: string;
  timeout?: number;
  elapsedMs?: number;
  connectionClosed?: boolean;
}

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "kit-db-concurrency-"));
  const cleanups: (() => Promise<void>)[] = [];
  t.after(async () => {
    await Promise.all(cleanups.map((cleanup) => cleanup()));
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, cleanups };
}

function worker(f: ReturnType<typeof fixture>, mode: string, id = mode) {
  const { dir } = f;
  const source = import.meta.url.endsWith(".ts");
  const child = spawn(
    process.execPath,
    [
      ...(source ? ["--import", import.meta.resolve("tsx")] : []),
      "--input-type=module",
      "-e",
      WORKER,
      new URL(source ? "./db.ts" : "./db.js", import.meta.url).href,
      mode,
      id,
    ],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        KIT_MEMORY_DIR: dir,
        KIT_MEMORY_DB: join(dir, "memory.db"),
        KIT_DEVICE_ID: "db-concurrency-fixture",
      },
    },
  );
  let stderr = "";
  child.on("error", (error) => (stderr += error.message));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  const events: WorkerEvent[] = [];
  const readers = new Set<() => void>();
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    events.push(JSON.parse(line));
    for (const reader of readers) reader();
  });
  let exited = false;
  const closed = new Promise<void>((resolve) => {
    child.on("close", () => {
      exited = true;
      for (const reader of readers) reader();
      resolve();
    });
  });
  f.cleanups.push(async () => {
    if (!exited) child.kill("SIGKILL");
    await closed;
    lines.close();
  });
  return {
    resume: () => child.stdin.write("x"),
    closed,
    wait: (event: string): Promise<WorkerEvent> =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => finish(new Error(`waiting for ${event}: ${stderr}`)),
          10_000,
        );
        const finish = (error?: Error, value?: WorkerEvent) => {
          clearTimeout(timer);
          readers.delete(check);
          if (error) reject(error);
          else resolve(value!);
        };
        const check = () => {
          const value = events.find((item) => item.event === event);
          if (value) finish(undefined, value);
          else if (exited) finish(new Error(`worker exited before ${event}: ${stderr}`));
        };
        readers.add(check);
        check();
      }),
  };
}

function assertOpened(result: WorkerEvent): void {
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.version, [{ version: SCHEMA_VERSION }]);
  assert.equal(result.journal, "wal");
  assert.equal(result.timeout, 5000);
}

it("opens after a real competing rollback-journal writer releases the WAL transition", async (t) => {
  const f = fixture(t);
  const holder = worker(f, "holder");
  await holder.wait("locked");
  const opener = worker(f, "wal");
  await opener.wait("ready");
  opener.resume();
  const busy = await opener.wait("busy");
  assert.equal(busy.errcode, 5, JSON.stringify(busy));
  holder.resume();
  await holder.wait("released");
  opener.resume();
  assertOpened(await opener.wait("result"));
  await Promise.all([holder.closed, opener.closed]);
});

function seedLegacyDatabase(path: string): unknown {
  seedLegacyPalDb(path, [{ id: "retained", title: "retained" }]);
  const seed = new DatabaseSync(path);
  const template = openMemoryDb(":memory:");
  try {
    for (const name of ["messages", "messages_fts", "messages_ai", "messages_ad", "messages_au"]) {
      seed.exec(
        String(template.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(name)!.sql),
      );
    }
    seed.exec(`
        ALTER TABLE pending_actions ADD COLUMN sync_id TEXT;
        UPDATE pending_actions SET sync_id='11111111111111111111111111111111';
        INSERT INTO messages (uuid, session_id, type, content)
          VALUES ('retained-message', 'fixture', 'user', 'legacycontinuity');
        ALTER TABLE pending_actions DROP COLUMN origin_device;
        ALTER TABLE messages DROP COLUMN class;
        UPDATE schema_meta SET version = 4;
    `);
    return seed.prepare("SELECT sync_id FROM pending_actions WHERE id = 'retained'").get()?.sync_id;
  } finally {
    template.close();
    seed.close();
  }
}

function assertMigratedData(path: string, existing: boolean, retainedIdentity: unknown) {
  const db = new DatabaseSync(path);
  try {
    assert.deepEqual(
      db
        .prepare("SELECT title FROM pending_actions ORDER BY title")
        .all()
        .map((row) => row.title),
      existing ? ["first", "retained", "second"] : ["first", "second"],
    );
    assert.equal(db.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
    if (existing) {
      assert.equal(
        db.prepare("SELECT sync_id FROM pending_actions WHERE id = 'retained'").get()?.sync_id,
        retainedIdentity,
      );
      assert.equal(
        db.prepare("SELECT class FROM messages WHERE uuid = 'retained-message'").get()?.class,
        "restricted",
      );
      assert.equal(
        db
          .prepare(
            "SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'legacycontinuity'",
          )
          .get()?.n,
        1,
      );
      db.exec("UPDATE messages SET content = 'updatedcontinuity' WHERE uuid = 'retained-message'");
      assert.equal(
        db
          .prepare(
            "SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'updatedcontinuity'",
          )
          .get()?.n,
        1,
      );
      assert.equal(
        db
          .prepare(
            "SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'legacycontinuity'",
          )
          .get()?.n,
        0,
      );
    }
  } finally {
    db.close();
  }
}

for (const existing of [false, true]) {
  it(`serializes ${existing ? "legacy" : "fresh"} schema inspection and migration across processes`, async (t) => {
    const f = fixture(t);
    const path = join(f.dir, "memory.db");
    const retainedIdentity = existing ? seedLegacyDatabase(path) : undefined;
    const first = worker(f, "migration", "first");
    const second = worker(f, "open", "second");
    await Promise.all([first.wait("ready"), second.wait("ready")]);
    first.resume();
    await first.wait("inspected");
    const observer = new DatabaseSync(path);
    try {
      // A competing writer must be excluded before the migration checks columns.
      assert.throws(() => observer.exec("BEGIN IMMEDIATE"), { errcode: 5 });
      const versions = observer
        .prepare("SELECT name FROM sqlite_master WHERE name = 'schema_meta'")
        .all();
      assert.equal(
        versions.length,
        existing ? 1 : 0,
        "fresh schema must not be partially published",
      );
    } finally {
      observer.close();
    }
    second.resume();
    first.resume();
    assertOpened(await first.wait("result"));
    assertOpened(await second.wait("result"));
    await Promise.all([first.closed, second.closed]);
    assertMigratedData(path, existing, retainedIdentity);
  });
}

it("rolls back a failed migration, closes its connection, and allows a later startup", (t) => {
  const f = fixture(t);
  const path = join(f.dir, "memory.db");
  const exec = DatabaseSync.prototype.exec;
  const failure = Object.assign(new Error("fixture migration failure"), { errcode: 19 });
  const captured: { connection?: DatabaseSync } = {};
  let attempts = 0;
  const mock = t.mock.method(
    DatabaseSync.prototype,
    "exec",
    function (this: DatabaseSync, sql: string) {
      if (sql === "ALTER TABLE pending_actions ADD COLUMN origin_root TEXT") {
        captured.connection = this;
        attempts++;
        throw failure;
      }
      return exec.call(this, sql);
    },
  );
  try {
    assert.throws(
      () => openMemoryDb(path),
      (error) => error === failure,
    );
    assert.equal(attempts, 1, "failed migration writes must not be replayed");
    assert.ok(captured.connection);
    assert.equal(
      captured.connection.isOpen,
      false,
      "failed initialization must close its connection",
    );
    const observer = new DatabaseSync(path);
    try {
      assert.equal(
        observer
          .prepare("SELECT count(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
          .get()?.n,
        0,
      );
      observer.exec("BEGIN IMMEDIATE; ROLLBACK");
    } finally {
      observer.close();
    }
  } finally {
    mock.mock.restore();
    if (captured.connection?.isOpen) captured.connection.close();
  }
  const recovered = openMemoryDb(path);
  assert.deepEqual(
    recovered
      .prepare("SELECT version FROM schema_meta")
      .all()
      .map((row) => row.version),
    [SCHEMA_VERSION],
  );
  recovered.close();
});

it("two simultaneous openers retain both writes on fresh databases", async (t) => {
  for (let attempt = 0; attempt < 8; attempt++) {
    await t.test(`fresh database ${attempt + 1}`, async (t) => {
      const f = fixture(t);
      const first = worker(f, "open", "first");
      const second = worker(f, "open", "second");
      await Promise.all([first.wait("ready"), second.wait("ready")]);
      first.resume();
      second.resume();
      const results = await Promise.all([first.wait("result"), second.wait("result")]);
      results.forEach(assertOpened);
      await Promise.all([first.closed, second.closed]);
      const db = new DatabaseSync(join(f.dir, "memory.db"));
      try {
        assert.deepEqual(
          db
            .prepare("SELECT title FROM pending_actions ORDER BY title")
            .all()
            .map((row) => row.title),
          ["first", "second"],
        );
        assert.equal(
          db.prepare("SELECT count(DISTINCT sync_id) AS n FROM pending_actions").get()?.n,
          2,
        );
      } finally {
        db.close();
      }
    });
  }
});

it("a held WAL transition lock exhausts one five-second budget and closes the failed opener", async (t) => {
  const f = fixture(t);
  const holder = worker(f, "holder");
  await holder.wait("locked");
  const opener = worker(f, "open");
  await opener.wait("ready");
  opener.resume();
  const result = await opener.wait("result");
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.errcode, 5);
  assert.equal(result.connectionClosed, true);
  assert.ok(
    result.elapsedMs !== undefined && result.elapsedMs >= 4900 && result.elapsedMs < 6000,
    JSON.stringify(result),
  );
  holder.resume();
  await holder.wait("released");
  await Promise.all([holder.closed, opener.closed]);
  const recovered = openMemoryDb(join(f.dir, "memory.db"));
  try {
    assert.equal(recovered.prepare("SELECT count(*) AS n FROM pending_actions").get()?.n, 0);
  } finally {
    recovered.close();
  }
});

it("propagates a non-busy WAL error once and closes the failed connection", (t) => {
  const f = fixture(t);
  const exec = DatabaseSync.prototype.exec;
  const failure = Object.assign(new Error("fixture journal error"), { errcode: 10 });
  const captured: { connection?: DatabaseSync } = {};
  let attempts = 0;
  const mock = t.mock.method(
    DatabaseSync.prototype,
    "exec",
    function (this: DatabaseSync, sql: string) {
      if (sql === "PRAGMA journal_mode = WAL") {
        captured.connection = this;
        attempts++;
        throw failure;
      }
      return exec.call(this, sql);
    },
  );
  try {
    assert.throws(
      () => openMemoryDb(join(f.dir, "memory.db")),
      (error) => error === failure,
    );
    assert.equal(attempts, 1);
    assert.ok(captured.connection);
    assert.equal(captured.connection.isOpen, false);
  } finally {
    mock.mock.restore();
    if (captured.connection?.isOpen) captured.connection.close();
  }
});
