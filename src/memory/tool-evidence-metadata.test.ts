import { it } from "node:test";
import assert from "node:assert/strict";
import { insertToolUse } from "./db.js";
import { APIS, MODES, INJECTION, metadataFixture } from "./metadata-import.test-support.js";

for (const mode of MODES)
  for (const api of APIS) {
    it(`tool metadata remains subject to the import gate (${mode}, ${api})`, (t) => {
      const f = metadataFixture(t);
      const target = f.target();
      const { path } = f.exportMemory(mode, "sender", (db) => {
        insertToolUse(db, {
          messageUuid: "sender-message",
          sessionId: "sender",
          toolName: INJECTION,
          callId: "call-1",
        });
        db.exec("UPDATE messages SET quarantined=1");
      });
      assert.throws(() => f.importMemory(target, path, api), /injection|unsafe|rejected|blocked/i);
      assert.equal(target.prepare("SELECT COUNT(*) n FROM tool_uses").get()?.n, 0);
    });
  }
