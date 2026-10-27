import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import type { SecurityCheckResult } from "./check-security.js";
import { syncSecurityFindings } from "./findings-track.js";
import { openMemoryDb } from "./memory/db.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const oldFinding: SecurityCheckResult = {
  category: "dependency",
  name: "npm audit",
  status: "fail",
  detail: "one vulnerable dependency",
};
const namedFinding: SecurityCheckResult = { ...oldFinding, name: "npm audit [frontend]" };

function openFindings(path: string): Array<{ id: string; title: string }> {
  const db = openMemoryDb(path);
  try {
    return db
      .prepare("SELECT id, title FROM pending_actions WHERE kind='finding' AND status='open'")
      .all() as Array<{ id: string; title: string }>;
  } finally {
    db.close();
  }
}

it("root migration closes old findings but a subproject scan closes only its own", async () => {
  const originalCwd = process.cwd();
  const originalDb = process.env.KIT_MEMORY_DB;
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kit-findings-projects-")));
  const frontend = join(root, "frontend");
  const dbPath = join(root, "memory.db");
  try {
    mkdirSync(frontend);
    execFileSync("git", ["init", "-q"], { cwd: root });
    process.env.KIT_MEMORY_DB = dbPath;

    process.chdir(root);
    const old = await syncSecurityFindings([oldFinding], ["security"]);
    assert.equal(old?.added, 1);

    const migrated = await syncSecurityFindings([namedFinding], ["security"]);
    assert.deepEqual([migrated?.added, migrated?.closed.length], [1, 1]);
    assert.deepEqual(
      openFindings(dbPath).map((f) => f.title),
      ["npm audit [frontend]: fail"],
    );

    process.chdir(frontend);
    const subproject = await syncSecurityFindings([oldFinding], ["security"]);
    assert.equal(subproject?.added, 1);
    const subprojectCleared = await syncSecurityFindings([], ["security"]);
    assert.equal(subprojectCleared?.closed.length, 1);

    const remaining = openFindings(dbPath);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].title, "npm audit [frontend]: fail");
  } finally {
    process.chdir(originalCwd);
    if (originalDb === undefined) delete process.env.KIT_MEMORY_DB;
    else process.env.KIT_MEMORY_DB = originalDb;
    rmTemp(root);
  }
});
