import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import { fixture, closedSource, modes } from "./backup.test-support.js";

for (const mode of modes) {
  for (const journal of ["WAL", "DELETE"]) {
    it(`${mode.name} refuses restore over a destination with ${journal} sidecars, then succeeds offline`, (t) => {
      const { src, blob, dest, track } = fixture(t);
      closedSource(src);
      mode.backup(src, blob);
      closedSource(dest);
      const writer = new DatabaseSync(dest);
      try {
        writer.exec(`PRAGMA journal_mode = ${journal}; BEGIN IMMEDIATE;
          UPDATE original SET content = 'destination state'`);
        if (journal === "WAL") writer.exec("COMMIT");
        const suffix = journal === "WAL" ? "-wal" : "-journal";
        assert.ok(existsSync(dest + suffix));
        const before = readFileSync(dest);
        const sidecar = readFileSync(dest + suffix);
        assert.throws(() => mode.restore(blob, dest), /SQLite sidecar.*offline/i);
        assert.deepEqual(readFileSync(dest), before);
        assert.deepEqual(readFileSync(dest + suffix), sidecar);
        assert.equal(
          writer.prepare("SELECT content FROM original").get()?.content,
          "destination state",
        );
        if (journal === "DELETE") writer.exec("ROLLBACK");
      } finally {
        writer.close();
      }
      mode.restore(blob, dest);
      const restored = track(new DatabaseSync(dest, { readOnly: true }));
      assert.equal(restored.prepare("SELECT content FROM original").get()?.content, "preserved");
      assert.equal(restored.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
    });
  }
}
