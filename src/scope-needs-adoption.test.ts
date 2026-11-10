import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { scanGovernanceCalls } from "./scope-needs-scanner.test-support.js";

/**
 * Scope-needs adoption gate.
 *
 * `withGovernance` checks `scopeNeeds` against the signed [scope]/RoE — but a
 * check nobody feeds is a structural no-op: the field existed for a full minor
 * series with ZERO production call sites declaring anything, which is exactly
 * the "silently no-op" failure the 6.0 plan warns about. This gate makes that
 * silence impossible: every `withGovernance` / `runGovernedBrokered` call site
 * in production code must either declare its effects or sit on the explicit
 * reviewed list below WITH a reason. An undeclared new site fails the build
 * instead of quietly bypassing scope mediation.
 *
 * Same pattern as the CLI=MCP drift guard and the publish-ordering tests:
 * drift is a test failure, never a silent regression.
 */

// Repo root: this compiled test lives at dist/scope-needs-adoption.test.js.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(REPO_ROOT, "src");

/**
 * Call sites reviewed and consciously left undeclared. This is NOT a
 * zero-effects claim — it is "a maintainer looked, and here is why no
 * declaration is made". Every entry must still match a real call site
 * (checked below), so the list cannot rot.
 */
const REVIEWED_UNDECLARED: { file: string; operation: string; reason: string }[] = [
  {
    file: "src/commands/check.ts",
    operation: "check",
    reason: "pure read — verification only; no egress, writes, or secret exposure",
  },
  {
    file: "src/commands/ci.ts",
    operation: "check",
    reason: "pure read — CI rendering of the same checks",
  },
  {
    file: "src/commands/review.ts",
    operation: "review",
    reason:
      "pure read — the four audit stages (check/design/standards/adr) via collectReview; no egress, writes, or secret exposure",
  },
  {
    file: "src/commands/info.ts",
    operation: "health",
    reason:
      "read-only sensors; the PAL sync writes kit-internal state under ~/.kit, which the project [scope] RoE does not govern",
  },
  {
    file: "src/commands/install.ts",
    operation: "tools.install",
    reason:
      "infrastructure — mise provisioning into $HOME, mirrors the MCP site's `infrastructure: true`; no project-scope effects to declare",
  },
  {
    file: "src/commands/login.ts",
    operation: "services.login",
    reason:
      "egress happens inside provider CLIs' own subprocesses; hosts are adapter-owned and not statically enumerable — per-adapter needs is a named follow-up",
  },
];

interface CallSite {
  file: string;
  wrapper: string;
  operation: string | null;
  declared: boolean;
}

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) collectSourceFiles(p, out);
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

function findCallSites(): CallSite[] {
  const sites: CallSite[] = [];
  for (const path of collectSourceFiles(SRC)) {
    const rel = relative(REPO_ROOT, path).split("\\").join("/");
    // The wrappers' own definitions are not call sites.
    if (rel === "src/governance-middleware.ts") continue;
    for (const site of scanGovernanceCalls(readFileSync(path, "utf8"))) {
      sites.push({ file: rel, ...site });
    }
  }
  return sites;
}

describe("scope-needs adoption gate", () => {
  const sites = findCallSites();

  it("finds the governed call sites at all (the scanner itself must not rot)", () => {
    // If a refactor renames the wrappers or moves everything, this gate would
    // otherwise pass vacuously — require a sane minimum.
    assert.ok(
      sites.length >= 8,
      `expected at least 8 governed call sites, found ${sites.length} — did the wrappers get renamed?`,
    );
  });

  it("every governed call site declares its effects or is explicitly reviewed", () => {
    const undeclared = sites.filter(
      (s) =>
        !s.declared &&
        !REVIEWED_UNDECLARED.some((r) => r.file === s.file && r.operation === s.operation),
    );
    assert.deepEqual(
      undeclared.map((s) => `${s.file} (${s.wrapper} "${s.operation}")`),
      [],
      "undeclared governed call site(s) — declare scopeNeeds/broker effects, or add a REVIEWED_UNDECLARED entry with a reason",
    );
  });

  it("the reviewed list matches real call sites (no rot)", () => {
    const stale = REVIEWED_UNDECLARED.filter(
      (r) => !sites.some((s) => s.file === r.file && s.operation === r.operation && !s.declared),
    );
    assert.deepEqual(
      stale.map((r) => `${r.file} ("${r.operation}")`),
      [],
      "stale REVIEWED_UNDECLARED entries — the site now declares needs (remove the entry) or moved (update it)",
    );
  });

  it("the flagship declarations stay declared", () => {
    // secrets.generate and fix are the two CLI sites with statically-known
    // effects — the dogfood proof that scope mediation runs on kit itself.
    for (const op of ["secrets.generate", "fix"]) {
      const site = sites.find((s) => s.operation === op && s.wrapper === "withGovernance");
      assert.ok(site, `withGovernance site for "${op}" not found`);
      assert.equal(site.declared, true, `"${op}" lost its scopeNeeds declaration`);
    }
  });
});
