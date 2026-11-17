import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSharedPath, shareEntry } from "./shared.js";
import { rmTemp } from "../temp-cleanup.test-support.js";

describe("shared memory author", () => {
  it("records the git name as author, never the git email", (t) => {
    const r = mkdtempSync(join(tmpdir(), "kit-shared-author-"));
    t.after(() => rmTemp(r));
    execFileSync("git", ["init", "-q", r]);
    execFileSync("git", ["config", "user.name", "Alice Fixture"], { cwd: r });
    execFileSync("git", ["config", "user.email", "alice@example.com"], { cwd: r });
    const e = shareEntry(
      r,
      { area: "a", kind: "decision", title: "t", body: "b" },
      "2026-06-16T00:00:00Z",
    );
    assert.equal(e.author, "Alice Fixture");
    assert.ok(!readFileSync(getSharedPath(r), "utf8").includes("@"), "no address on disk");
  });
});
