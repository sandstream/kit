import { it } from "node:test";
import assert from "node:assert/strict";
import {
  openMemoryDb,
  upsertSession,
  insertMessage,
  searchMessages,
  recentMessages,
} from "./db.js";

it("scopes Windows paths across separators and case without crossing directory boundaries", () => {
  const db = openMemoryDb(":memory:");
  try {
    upsertSession(db, { sessionId: "windows-scope", harness: "codex" });
    const paths = [
      ["root", "C:\\Users\\Case\\repo_%"],
      ["native-child", "C:\\Users\\Case\\repo_%\\src"],
      ["git-child", "C:/Users/case/repo_%/src"],
      ["sibling", "C:\\Users\\Case\\repo_%X\\src"],
      ["other-drive", "D:\\Users\\Case\\repo_%\\src"],
      ["foreign-posix", "/Users/Case/repo_%/src"],
    ] as const;
    for (const [uuid, cwd] of paths)
      insertMessage(db, {
        uuid,
        sessionId: "windows-scope",
        type: "assistant",
        content: "windowsscopefixture",
        cwd,
      });
    const projectPath = "C:\\Users\\Case\\repo_%";
    const expected = ["git-child", "native-child", "root"];
    assert.deepEqual(
      searchMessages(db, "windowsscopefixture", { projectPath })
        .map((hit) => hit.uuid)
        .sort(),
      expected,
    );
    assert.deepEqual(
      recentMessages(db, { projectPath })
        .map((hit) => hit.uuid)
        .sort(),
      expected,
    );
    assert.deepEqual(
      searchMessages(db, "windowsscopefixture", { projectPath: "/Users/Case/repo_%" }).map(
        (hit) => hit.uuid,
      ),
      ["foreign-posix"],
    );
  } finally {
    db.close();
  }
});
