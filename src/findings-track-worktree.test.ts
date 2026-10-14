import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { syncSecurityFindings } from "./findings-track.js";
import { openMemoryDb } from "./memory/db.js";
import type { SecurityCheckResult } from "./check-security.js";

// PAL-WT-2: the same scanner finding raised in two live worktrees of one repo used to be
// two open actions. Findings that are not about the code (an advisory such as threat-intel
// catalog age) now share one scope: the main checkout. Findings about the code stay per
// worktree, because one worktree's clean scan must not close a finding another worktree
// still has.

const ADVISORY: SecurityCheckResult = {
  category: "supply-chain",
  name: "bumblebee",
  status: "pass",
  detail: "catalogs are old",
  advisory: { key: "bumblebee-catalog-age", title: "catalogs are old", detail: "111 days" },
};
const CODE_FINDING: SecurityCheckResult = {
  category: "dependency",
  name: "osv-scanner",
  status: "fail",
  detail: "vulnerable dependency",
};

let base: string;
let main: string;
let wtA: string;
let wtB: string;
let dbPath: string;
let originalCwd: string;
let originalDb: string | undefined;

before(() => {
  originalCwd = process.cwd();
  originalDb = process.env.KIT_MEMORY_DB;
  base = realpathSync(mkdtempSync(join(tmpdir(), "kit-wt2-")));
  main = join(base, "main");
  wtA = join(base, "a");
  wtB = join(base, "b");
  mkdirSync(main);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: main, stdio: "pipe" });
  git("init", "-q");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
  git("worktree", "add", "-q", "-b", "a", wtA);
  git("worktree", "add", "-q", "-b", "b", wtB);
  dbPath = join(base, "memory.db");
  process.env.KIT_MEMORY_DB = dbPath;
});

after(() => {
  process.chdir(originalCwd);
  if (originalDb === undefined) delete process.env.KIT_MEMORY_DB;
  else process.env.KIT_MEMORY_DB = originalDb;
  rmSync(base, { recursive: true, force: true });
});

function openIds(source: string): string[] {
  const db = openMemoryDb(dbPath);
  try {
    return (
      db
        .prepare("SELECT id FROM pending_actions WHERE status='open' AND id LIKE ?")
        .all(`${source}-%`) as Array<{ id: string }>
    ).map((r) => r.id);
  } finally {
    db.close();
  }
}

describe("syncSecurityFindings across worktrees (PAL-WT-2)", () => {
  it("raises an advisory once for two worktrees of one repo", async () => {
    process.chdir(wtA);
    await syncSecurityFindings([ADVISORY]);
    process.chdir(wtB);
    await syncSecurityFindings([ADVISORY]);
    assert.equal(openIds("adv").length, 1, "one advisory action, not one per worktree");
  });

  it("keeps a code finding per worktree", async () => {
    process.chdir(wtA);
    await syncSecurityFindings([CODE_FINDING]);
    process.chdir(wtB);
    await syncSecurityFindings([CODE_FINDING]);
    assert.equal(openIds("sec").length, 2, "each worktree owns its own code finding");
  });

  it("a clean scan in one worktree does not close another worktree's code finding", async () => {
    process.chdir(wtA);
    await syncSecurityFindings([]);
    assert.equal(openIds("sec").length, 1, "worktree B still has its finding");
  });
});
