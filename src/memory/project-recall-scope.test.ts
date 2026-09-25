import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectRecallClause } from "./project-recall-scope.js";

function matches(projectPath: string, rows: Array<[string, string | null]>): string[] {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE messages (cwd TEXT, recall_cwd TEXT)");
    const insert = db.prepare("INSERT INTO messages (cwd, recall_cwd) VALUES (?, ?)");
    for (const [cwd, recall] of rows) insert.run(cwd, recall);
    const { sql, params } = projectRecallClause(db, projectPath);
    return db
      .prepare(`SELECT COALESCE(m.recall_cwd, m.cwd) AS at FROM messages m WHERE ${sql}`)
      .all(...params)
      .map((r) => String(r.at));
  } finally {
    db.close();
  }
}

describe("projectRecallClause", () => {
  it("matches the root and its subdirectories, but not a sibling sharing a name prefix", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "kit-recall-scope-")));
    try {
      const got = matches(root, [
        [root, null],
        [join(root, "src"), null],
        [`${root}-other`, null],
        [join(tmpdir(), "unrelated"), null],
      ]);
      assert.deepEqual(got.sort(), [root, join(root, "src")].sort());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("scopes on recall_cwd when a row carries one, over its raw cwd", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "kit-recall-scope-")));
    try {
      const got = matches(root, [
        ["/somewhere/else", root],
        [root, "/somewhere/else"],
      ]);
      assert.deepEqual(got, [root]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it(
    "compares a Windows-form root case-insensitively at a separator boundary",
    { skip: process.platform === "win32" && "a foreign-OS root is the case under test" },
    () => {
      const got = matches("C:\\Repo", [
        ["c:\\repo", null],
        ["C:\\REPO\\src", null],
        ["C:\\Repository", null],
      ]);
      assert.deepEqual(got.sort(), ["C:\\REPO\\src", "c:\\repo"].sort());
    },
  );
});
