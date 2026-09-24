import assert from "node:assert/strict";
import fs, { statSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import { fixture, modes, restoreMocks } from "./backup.test-support.js";

for (const mode of modes) {
  it(`${mode.name}: backup and restore do not read a large snapshot or blob into one buffer`, (t) => {
    const files = fixture(t);
    const source = new DatabaseSync(files.src);
    try {
      source.exec(
        "CREATE TABLE payload (value BLOB); INSERT INTO payload VALUES (zeroblob(4 * 1024 * 1024))",
      );
    } finally {
      source.close();
    }

    const readFile = fs.readFileSync;
    t.mock.method(fs, "readFileSync", (...args: Parameters<typeof readFile>) => {
      const path = args[0];
      if (
        typeof path === "string" &&
        (statSync(path, { throwIfNoEntry: false })?.size ?? 0) > 512 * 1024
      ) {
        throw new Error("whole-file read refused by resource contract");
      }
      return readFile(...args);
    });
    syncBuiltinESMExports();
    try {
      mode.backup(files.src, files.blob);
      mode.restore(files.blob, files.dest);
    } finally {
      restoreMocks(t);
    }

    const restored = new DatabaseSync(files.dest, { readOnly: true });
    try {
      assert.equal(
        restored.prepare("SELECT length(value) AS bytes FROM payload").get()?.bytes,
        4 * 1024 * 1024,
      );
      assert.equal(restored.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
    } finally {
      restored.close();
    }
  });
}
