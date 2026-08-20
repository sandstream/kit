import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { CHECK_FLAGS } from "./check.js";
import { GLOBAL_FLAGS } from "../utils/flags.js";

/**
 * The allowlist behind `kit check`'s unknown-flag rejection must cover every flag the check path
 * actually honors — including the ones read by CALLEES, not just the ones the handler file reads.
 *
 * This is not a hypothetical. The first version of CHECK_FLAGS was built from the flag literals in
 * commands/check.ts alone, so `kit check --attest` (documented in the README as the opt-in signed
 * receipt of which scanners ran) exited 1 with "unknown flag for kit check: --attest" and the check
 * never ran — the mirror image of a false green. `--no-auto-install` broke the same way. Both are
 * read in cli-checks-shared.ts, one import away.
 *
 * The ORACLE here is the source of the modules on the check path, not a second copy of the list:
 * a test that restated the flags would have passed happily while the flag was rejected in
 * production. So we grep the argv readers and require every literal to be allowed.
 */

// Modules that participate in a `kit check` invocation and read process.argv directly.
const CHECK_PATH_MODULES = ["src/commands/check.ts", "src/cli-checks-shared.ts"];

// hasFlag(process.argv, "--x") / flagValue(process.argv, "--x") — the two argv readers in kit.
const ARGV_FLAG_RE = /\b(?:hasFlag|flagValue)\(\s*process\.argv\s*,\s*"(--[a-z][a-z0-9-]*)"/g;

function repoRoot(): string {
  // dist/commands/check-flags.test.js → repo root is two levels up from dist/commands.
  return resolve(import.meta.dirname, "..", "..");
}

function flagsReadBy(relPath: string): string[] {
  const src = readFileSync(resolve(repoRoot(), relPath), "utf-8");
  return [...src.matchAll(ARGV_FLAG_RE)].map((m) => m[1]);
}

describe("kit check flag allowlist", () => {
  it("the oracle itself finds something (guard against a regex that silently matches nothing)", () => {
    // Five separate measurement bugs in this repo's history were regexes that matched nothing and
    // were read as "no occurrences". A coverage test whose scanner is broken reports perfect
    // coverage, so assert the scanner works before trusting its verdict.
    const found = CHECK_PATH_MODULES.flatMap(flagsReadBy);
    assert.ok(found.length >= 5, `the argv-reader scan found only ${found.length} flags`);
    assert.ok(found.includes("--json"), "expected the scan to see --json");
  });

  it("every flag read on the check path is in CHECK_FLAGS", () => {
    const allowed = new Set<string>(CHECK_FLAGS);
    const missing: string[] = [];
    for (const mod of CHECK_PATH_MODULES) {
      for (const flag of flagsReadBy(mod)) {
        if (!allowed.has(flag)) missing.push(`${flag} (read in ${mod})`);
      }
    }
    assert.deepEqual(
      missing,
      [],
      `these flags are honored by the check path but rejected as unknown: ${missing.join(", ")}`,
    );
  });

  it("covers the two flags whose absence broke documented invocations", () => {
    // Named explicitly so a future refactor that moves them out of the scanned modules cannot
    // silently drop them from the allowlist.
    assert.ok(CHECK_FLAGS.includes("--attest"), "kit check --attest is documented in README.md");
    assert.ok(CHECK_FLAGS.includes("--no-auto-install"));
  });

  it("lists no flag twice, and every entry is a long flag", () => {
    assert.equal(new Set(CHECK_FLAGS).size, CHECK_FLAGS.length, "duplicate entry in CHECK_FLAGS");
    for (const f of CHECK_FLAGS) assert.match(f, /^--[a-z][a-z0-9-]*$/, f);
  });
});

describe("kit check accepts the documented global flags", () => {
  /**
   * `--read-only` and `--non-interactive` are honored by cli.ts for every command
   * and are in docs/COMMANDS.md's global table, but CHECK_FLAGS was built from the
   * check path's own literals — so `kit check --read-only` exited 1 with "unknown
   * flag" and the security check never ran. Same class as the `--attest` break
   * above: a gate that refuses to run is a false red.
   */
  it("CHECK_FLAGS is a superset of GLOBAL_FLAGS", () => {
    const allowed = new Set<string>(CHECK_FLAGS);
    const missing = (GLOBAL_FLAGS as readonly string[]).filter((f) => !allowed.has(f));
    assert.deepEqual(missing, [], `globals kit check would reject: ${missing.join(", ")}`);
  });
});
