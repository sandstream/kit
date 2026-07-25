import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MEMORY_CLASSES,
  DEFAULT_MEMORY_CLASS,
  MOST_RESTRICTIVE_CLASS,
  classRank,
  isMemoryClass,
  parseMemoryClass,
  resolveMemoryClass,
  classPermitsDisclosure,
  disclosableClasses,
  type MemoryClass,
} from "./class.js";
import { openMemoryDb, insertMessage, upsertSession, searchMessages } from "./db.js";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("memory class ordering", () => {
  it("is least → most restrictive, and the order is the policy", () => {
    assert.deepEqual([...MEMORY_CLASSES], ["public", "internal", "restricted"]);
    assert.ok(classRank("public") < classRank("internal"));
    assert.ok(classRank("internal") < classRank("restricted"));
    assert.equal(MOST_RESTRICTIVE_CLASS, "restricted");
    assert.equal(DEFAULT_MEMORY_CLASS, "internal");
  });

  it("recognizes only the known labels", () => {
    assert.equal(isMemoryClass("internal"), true);
    for (const v of ["INTERNAL", "secret", "", null, undefined, 3, {}])
      assert.equal(isMemoryClass(v), false, `must reject ${JSON.stringify(v)}`);
  });
});

describe("parseMemoryClass — fails closed", () => {
  it("passes through a known label", () => {
    assert.deepEqual(parseMemoryClass("public"), { cls: "public", recognized: true });
  });

  it("an unknown/garbage label becomes restricted and is flagged unrecognized", () => {
    for (const v of ["secret", "Public", "", null, undefined, 42]) {
      const r = parseMemoryClass(v);
      assert.equal(r.cls, "restricted", `must fail closed for ${JSON.stringify(v)}`);
      assert.equal(r.recognized, false);
    }
  });
});

describe("resolveMemoryClass — config default + per-project override + env", () => {
  it("nothing configured ⇒ the documented default, not restricted", () => {
    const r = resolveMemoryClass({});
    assert.equal(r.cls, "internal");
    assert.equal(r.source, "default");
    assert.equal(r.recognized, true);
  });

  it("a project's configured value wins over the default", () => {
    const r = resolveMemoryClass({ configured: "restricted" });
    assert.equal(r.cls, "restricted");
    assert.equal(r.source, "config");
  });

  it("KIT_MEMORY_CLASS overrides config (ephemeral session)", () => {
    const r = resolveMemoryClass({ env: "public", configured: "restricted" });
    assert.equal(r.cls, "public");
    assert.equal(r.source, "env");
  });

  it("an INVALID configured value fails closed to restricted and is flagged", () => {
    // A typo must never silently WIDEN disclosure — that is the asymmetry that matters.
    const r = resolveMemoryClass({ configured: "publik" });
    assert.equal(r.cls, "restricted");
    assert.equal(r.source, "config");
    assert.equal(r.recognized, false);
  });

  it("an empty/whitespace env value is absent, not invalid (falls through)", () => {
    assert.equal(resolveMemoryClass({ env: "   ", configured: "public" }).cls, "public");
    assert.equal(resolveMemoryClass({ env: "" }).source, "default");
  });
});

describe("classPermitsDisclosure — the gate", () => {
  it("a row never flows into a LESS restrictive context", () => {
    assert.equal(classPermitsDisclosure("restricted", "internal"), false);
    assert.equal(classPermitsDisclosure("restricted", "public"), false);
    assert.equal(classPermitsDisclosure("internal", "public"), false);
  });

  it("a row flows into an equal or MORE restrictive context", () => {
    assert.equal(classPermitsDisclosure("public", "public"), true);
    assert.equal(classPermitsDisclosure("public", "restricted"), true);
    assert.equal(classPermitsDisclosure("internal", "internal"), true);
    assert.equal(classPermitsDisclosure("internal", "restricted"), true);
    assert.equal(classPermitsDisclosure("restricted", "restricted"), true);
  });
});

describe("disclosableClasses — SQL filter list", () => {
  it("widens with the context, and never lists a more restrictive class", () => {
    assert.deepEqual(disclosableClasses("public"), ["public"]);
    assert.deepEqual(disclosableClasses("internal"), ["public", "internal"]);
    assert.deepEqual(disclosableClasses("restricted"), ["public", "internal", "restricted"]);
  });

  it("omits NULL/unknown by construction — an unclassified row fails the IN test", () => {
    // The gate needs no NULL special-case: a row with no class simply is not in the list.
    for (const ctx of MEMORY_CLASSES) {
      const allowed: string[] = disclosableClasses(ctx);
      assert.ok(!allowed.includes("" as never));
      assert.ok(!allowed.includes("unknown" as never));
    }
  });
});

describe("class gate against a real store (#348)", () => {
  const mkMsg = (uuid: string, content: string, memoryClass?: MemoryClass) => ({
    uuid,
    sessionId: "s1",
    type: "user",
    role: "user",
    content,
    timestamp: new Date(0).toISOString(),
    memoryClass,
  });

  it("restricted rows never surface in a public or internal context; NULL never leaks", () => {
    const db = openMemoryDb(":memory:");
    upsertSession(db, { sessionId: "s1", harness: "claude-code" });
    insertMessage(db, mkMsg("u-pub", "zebra public note", "public"));
    insertMessage(db, mkMsg("u-int", "zebra internal note", "internal"));
    insertMessage(db, mkMsg("u-res", "zebra restricted note", "restricted"));
    // A row that predates classification / arrived from a peer with no class at all.
    db.prepare(
      "INSERT INTO messages (uuid, session_id, type, role, content, timestamp, quarantined, class) VALUES (?,?,?,?,?,?,0,NULL)",
    ).run("u-null", "s1", "user", "user", "zebra unclassified note", new Date(0).toISOString());

    const classesFor = (ctx: MemoryClass) =>
      searchMessages(db, "zebra", { contextClass: ctx, limit: 50 })
        .map((h) => h.uuid)
        .sort();

    assert.deepEqual(classesFor("public"), ["u-pub"], "public context sees only public");
    assert.deepEqual(classesFor("internal"), ["u-int", "u-pub"], "internal adds internal");
    assert.deepEqual(
      classesFor("restricted"),
      ["u-int", "u-pub", "u-res"],
      "restricted sees all CLASSIFIED rows",
    );
    // The NULL-class row is excluded from EVERY context — fail-closed by construction.
    for (const ctx of MEMORY_CLASSES) assert.ok(!classesFor(ctx).includes("u-null"));

    // Omitting contextClass keeps the pre-classification behavior (everything visible).
    const unfiltered = searchMessages(db, "zebra", { limit: 50 }).map((h) => h.uuid);
    assert.equal(unfiltered.length, 4);
    db.close();
  });

  it("insertMessage classifies with the documented default when the caller passes none", () => {
    const db = openMemoryDb(":memory:");
    upsertSession(db, { sessionId: "s1", harness: "claude-code" });
    insertMessage(db, mkMsg("u-default", "kangaroo unlabelled"));
    const row = db.prepare("SELECT class FROM messages WHERE uuid = ?").get("u-default") as {
      class: string;
    };
    assert.equal(row.class, DEFAULT_MEMORY_CLASS, "no row is born unclassifiable");
    db.close();
  });

  it("the v9 migration backfills pre-existing rows to the configured default", () => {
    // Simulate a store written before classification: create the table WITHOUT the column,
    // insert a row, then let openMemoryDb migrate it.
    const dir = mkdtempSync(join(tmpdir(), "kit-memclass-"));
    const dbPath = join(dir, "memory.db");
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(
      "CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT UNIQUE, session_id TEXT NOT NULL, parent_uuid TEXT, type TEXT NOT NULL, role TEXT, content TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER, timestamp TEXT, cwd TEXT, git_branch TEXT, version TEXT)",
    );
    legacy
      .prepare(
        "INSERT INTO messages (uuid, session_id, type, content) VALUES ('old','s0','user','legacy row')",
      )
      .run();
    legacy.close();

    const db = openMemoryDb(dbPath, { defaultClass: "restricted" });
    const row = db.prepare("SELECT class FROM messages WHERE uuid = 'old'").get() as {
      class: string;
    };
    assert.equal(row.class, "restricted", "backfilled to the configured default, not left NULL");
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
