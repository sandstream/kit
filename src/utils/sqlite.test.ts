import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { openSqlite } from "./sqlite.js";

describe("openSqlite", () => {
  it("opens a database with no options, as new DatabaseSync(path) does", () => {
    const db = openSqlite(":memory:");
    try {
      assert.equal(db.prepare("SELECT 1 AS one").get()?.one, 1);
    } finally {
      db.close();
    }
  });

  it("passes options through", () => {
    const db = openSqlite(":memory:", { open: false });
    assert.equal(db.isOpen, false);
  });
});
