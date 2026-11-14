import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditFloorFreeze } from "./floor-audit.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

function dir(t: { after(fn: () => void): void }): string {
  const d = mkdtempSync(join(tmpdir(), "kit-floor-audit-"));
  t.after(() => rmTemp(d));
  return d;
}

describe("auditFloorFreeze", () => {
  it("records a freeze in a repository with no .kit.toml", async (t) => {
    const d = dir(t);
    await auditFloorFreeze(["standards", "adr"], d);
    const row = JSON.parse(readFileSync(join(d, ".kit-audit.jsonl"), "utf8").trim());
    assert.equal(row.operation, "baseline-freeze");
    assert.equal(row.success, true);
    assert.deepEqual(row.metadata, { phase: "floor-freeze", categories: ["adr", "standards"] });
  });

  it("never throws on an unreadable .kit.toml, and records nothing", async (t) => {
    const d = dir(t);
    writeFileSync(join(d, ".kit.toml"), "this is = = not toml");
    await assert.doesNotReject(auditFloorFreeze(["adr"], d));
    assert.equal(existsSync(join(d, ".kit-audit.jsonl")), false);
  });
});
