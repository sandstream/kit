import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { it } from "node:test";
import { fixture, modes } from "./backup.test-support.js";
import { openMemoryDb } from "./db.js";
import { palAdd, palForget, palShow } from "./pal.js";

for (const mode of modes) {
  it(`${mode.name} raw restore cannot discard deletion knowledge from the destination`, (t) => {
    const { dir, src, blob, dest } = fixture(t);
    const db = openMemoryDb(src);
    const id = palAdd(db, { title: "Sensitive task" });
    db.close();
    mode.backup(src, blob);
    mode.restore(blob, dest);
    const local = openMemoryDb(dest);
    try {
      palForget(local, id, { expectedFrontier: palShow(local, id)!.frontier });
    } finally {
      local.close();
    }
    const before = readFileSync(dest);
    const files = readdirSync(dir).sort();
    assert.throws(() => mode.restore(blob, dest), /deletion.*memory sync/i);
    assert.deepEqual(readFileSync(dest), before);
    assert.deepEqual(readdirSync(dir).sort(), files);
  });
}
