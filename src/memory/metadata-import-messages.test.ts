import assert from "node:assert/strict";
import { it } from "node:test";
import { getStats, recentMessages, searchMessages } from "./db.js";
import {
  APIS,
  INJECTION,
  metadataFixture,
  MODES,
  seedMessage,
} from "./metadata-import.test-support.js";

const FIELDS = ["uuid", "session_id", "role", "model", "timestamp", "cwd", "git_branch"];

for (const mode of MODES) {
  for (const partial of [false, true]) {
    for (const quarantined of [false, true]) {
      for (const field of FIELDS) {
        it(`${mode}: refuses ${field}, partial=${partial}, quarantined=${quarantined}`, (t) => {
          const files = metadataFixture(t);
          const incoming = files.exportMemory(mode, "incoming", (db) => {
            db.prepare(`UPDATE messages SET ${field} = ?, quarantined = ?`).run(
              INJECTION,
              Number(quarantined),
            );
            if (partial)
              db.exec(`ALTER TABLE messages DROP COLUMN ${field === "cwd" ? "role" : "cwd"}`);
          });
          for (const api of APIS) {
            const target = files.target();
            seedMessage(target, "existing", files.root);
            const before = recentMessages(target);
            assert.throws(
              () => files.importMemory(target, incoming.path, api),
              /refusing to merge: incoming memory has .*high-confidence injection/,
              api,
            );
            assert.deepEqual(recentMessages(target), before, api);
            assert.deepEqual(searchMessages(target, "metadatarecall"), before, api);
            assert.deepEqual(getStats(target).tokens.byModel, [
              { model: "synthetic-model", messages: 1, inputTokens: 1, outputTokens: 0 },
            ]);
          }
        });
      }
    }
  }
}
