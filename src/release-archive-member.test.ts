import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { memberFindings } from "./release-archive-member.js";

describe("archive member findings", () => {
  it("fails a device entry, a hard link out of the tree, and Windows-style escapes", () => {
    const find = (m: Parameters<typeof memberFindings>[0]) => memberFindings(m).join();
    assert.match(find({ name: "dev", kind: "special", mode: 0 }), /special/);
    assert.match(find({ name: "h", kind: "hardlink", mode: 0, link: "../x" }), /hard link/);
    assert.match(find({ name: "..\\..\\x.exe", kind: "file", mode: 0 }), /"\.\."/);
    assert.match(find({ name: "C:\\Windows\\x", kind: "file", mode: 0 }), /absolute/);
  });

  it("allows a link that stays inside, and a setgid directory", () => {
    assert.deepEqual(memberFindings({ name: "a/b/l", kind: "symlink", mode: 0, link: "../c" }), []);
    assert.deepEqual(memberFindings({ name: "d/", kind: "dir", mode: 0o2755 }), []);
  });
});
