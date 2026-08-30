/**
 * ADR-0002's claim, enforced.
 *
 * WHY THIS FILE EXISTS. ADR-0002 is titled "Dependency floor — four runtime deps, stdlib
 * otherwise", and CLAUDE.md lists it among kit's deterministic rules. Its `kit-enforce`
 * block enforces something narrower: a `forbid_import` deny-list of twelve named packages
 * (lodash, axios, moment, …) checked in `src/**`. Measured — by accidentally adding a
 * fifth runtime dependency and watching the gate stay green — a new dependency that is not
 * on that list passes silently. The ADR declared more than it enforced.
 *
 * WHY NOT FIX IT IN THE ADR GATE. Two structural reasons, both measured rather than
 * assumed:
 *
 *  1. `package.json` is not in the file set the ADR gate walks. `CODE_EXTS` in
 *     `commands/adr.ts` is source extensions only, so no `kit-enforce` rule can ever apply
 *     to a manifest.
 *  2. `forbid_pattern` / `require_pattern` are matched LINE BY LINE (`firstMatchingLine`
 *     splits on newlines). A dependency entry in `dependencies` is textually identical to
 *     one in `devDependencies`, so a line-based regex cannot tell them apart, and a
 *     multi-line pattern pinning the whole block cannot match at all.
 *
 * Widening the walk and adding block-aware matching to serve one rule is a larger change
 * than the rule is worth. A test is the smaller, honest mechanism: it is deterministic, it
 * runs in CI already, and it fails the moment the claim stops being true.
 *
 * ADDING A DEPENDENCY IS AN ADR-LEVEL ACT. If a fifth is genuinely needed, amend or
 * supersede ADR-0002 in the same PR and update the list below. Editing this list alone to
 * make the suite green is the failure this test exists to catch.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The floor ADR-0002 declares. Changing this set requires amending that ADR. */
const RUNTIME_DEPENDENCIES = [
  "@modelcontextprotocol/sdk",
  "@upstash/redis",
  "smol-toml",
  "zod",
] as const;

function manifest(): { dependencies?: Record<string, string> } {
  return JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf-8")) as {
    dependencies?: Record<string, string>;
  };
}

describe("ADR-0002 dependency floor", () => {
  it("ships exactly the declared runtime dependencies — no more, no fewer", () => {
    const declared = Object.keys(manifest().dependencies ?? {}).sort();
    assert.deepEqual(
      declared,
      [...RUNTIME_DEPENDENCIES].sort(),
      "package.json's runtime dependencies drifted from ADR-0002's floor. A new runtime " +
        "dependency is an architecture decision: amend or supersede docs/adr/0002-dependency-floor.md " +
        "in the same PR. Note that a dev TOOL kit shells out to (a scanner, a linter) is not a " +
        "runtime dependency and must not be added here — install it as a tool.",
    );
  });

  it("pins every runtime dependency to an exact version", () => {
    // A range lets the floor move without anyone editing package.json, which would make
    // the assertion above true and the claim behind it false.
    for (const [name, range] of Object.entries(manifest().dependencies ?? {})) {
      assert.match(
        range,
        /^\d+\.\d+\.\d+$/,
        `${name} is pinned as "${range}" — ADR-0002's floor is only meaningful if the versions cannot float`,
      );
    }
  });
});
