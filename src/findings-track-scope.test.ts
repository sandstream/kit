import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { SecurityCheckResult } from "./check-security.js";
import { syncSecurityFindings } from "./findings-track.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

// A `kit check --category tools` run never looks at security, so its empty security list says
// nothing about whether tracked findings are still there. Reconciling it closed every open
// security finding of the project. A narrowed run must leave the ledger alone.

const FINDING: SecurityCheckResult = {
  category: "dependency",
  name: "osv-scanner",
  status: "fail",
  detail: "vulnerable dependency",
};

let dir: string;
let originalCwd: string;
let originalDb: string | undefined;

before(() => {
  originalCwd = process.cwd();
  originalDb = process.env.KIT_MEMORY_DB;
  dir = realpathSync(mkdtempSync(join(tmpdir(), "kit-findings-scope-")));
  process.env.KIT_MEMORY_DB = join(dir, "memory.db");
  process.chdir(dir);
});

after(() => {
  process.chdir(originalCwd);
  if (originalDb === undefined) delete process.env.KIT_MEMORY_DB;
  else process.env.KIT_MEMORY_DB = originalDb;
  rmTemp(dir);
});

describe("syncSecurityFindings with a narrowed run", () => {
  it("leaves tracked findings open when the security dimension did not run", async () => {
    const first = await syncSecurityFindings([FINDING]);
    assert.equal(first?.added, 1);

    const narrowed = await syncSecurityFindings([], ["tools", "upstream"]);
    assert.equal(narrowed, null, "a run that skipped security must not reconcile the ledger");

    // Had the narrowed run closed it, tracking the same finding again would reopen it.
    const again = await syncSecurityFindings([FINDING]);
    assert.deepEqual([again?.added, again?.reopened, again?.closed], [0, 0, []]);
  });

  it("still reconciles when security ran, narrowed or not", async () => {
    const cleared = await syncSecurityFindings([], ["security"]);
    assert.deepEqual(cleared?.closed.length, 1);
    const full = await syncSecurityFindings([FINDING], null);
    assert.equal(full?.reopened, 1);
  });
});
