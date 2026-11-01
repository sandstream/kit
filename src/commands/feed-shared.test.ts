import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { openMemoryDb } from "../memory/db.js";
import { trackAuthFailure } from "./feed-shared.js";

const titles = (db: ReturnType<typeof openMemoryDb>) =>
  db
    .prepare("SELECT title FROM pending_actions WHERE status='open'")
    .all()
    .map((r) => r.title);

describe("trackAuthFailure", () => {
  it("opens one login item per service and closes the connection it was given", () => {
    const db = openMemoryDb(":memory:");
    let closed = 0;
    Object.defineProperty(db, "close", { value: () => closed++ });
    const deps = { run: () => "", open: () => db };
    trackAuthFailure(deps, "vercel");
    trackAuthFailure(deps, "github");
    assert.deepEqual(titles(db).sort(), [
      "GitHub feed: not logged in",
      "Vercel feed: not logged in",
    ]);
    assert.equal(closed, 2);
  });

  it("never throws when the ledger cannot be opened", () => {
    const deps = {
      run: () => "",
      open: () => {
        throw new Error("database is locked");
      },
    };
    assert.doesNotThrow(() => trackAuthFailure(deps, "github"));
  });
});
