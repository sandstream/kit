import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ciTextRow } from "./cli-checks-shared.js";

describe("ciTextRow names the files a row is about", () => {
  const row = {
    name: "secrets scan",
    status: "warn" as const,
    detail: "7 file(s) with unverified secret-shaped strings in the working tree",
    category: "security/secrets",
  };

  it("prints the row alone when it carries no files", () => {
    assert.equal(ciTextRow("!", row), `  ! [security/secrets] secrets scan: ${row.detail}`);
  });

  it("lists up to five files and counts the rest", () => {
    const files = ["a", "b", "c", "d", "e", "f", "g"];
    const lines = ciTextRow("!", { ...row, files }).split("\n");
    assert.deepEqual(lines.slice(1), [
      "    • a",
      "    • b",
      "    • c",
      "    • d",
      "    • e",
      "    ... and 2 more file(s)",
    ]);
  });
});
