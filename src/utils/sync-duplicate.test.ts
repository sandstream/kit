import { describe, it } from "node:test";
import assert from "node:assert";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isSyncDuplicateName } from "./sync-duplicate.js";

describe("isSyncDuplicateName (cloud-sync copies of build output)", () => {
  it("recognises the copy iCloud/Dropbox leaves beside a file", () => {
    for (const name of [
      "check-security 2.test.js",
      "triage-gate 2.js",
      "audit.test 2.js.map",
      "package 2.json",
      "mise 2.toml",
      "cli 10.js",
      "notes copy.md",
      "notes copy 2.md",
    ]) {
      assert.strictEqual(isSyncDuplicateName(name), true, name);
    }
  });

  it("leaves legitimate names that merely contain digits or spaces alone", () => {
    for (const name of [
      "check-security.test.js",
      "openai-2.js",
      "es2022.d.ts",
      "top 10 findings.md",
      "v2.js",
      "sha2 256.js",
      "kit.opencli.json",
    ]) {
      assert.strictEqual(isSyncDuplicateName(name), false, name);
    }
  });
});

// The build-time gate (scripts/check-conflict-copies.mjs) has to answer the same question as
// this module, but it runs BEFORE tsc, when dist/ may be absent or stale — so it cannot import
// the compiled version and carries its own copy of the predicate. Two copies of a rule drift
// silently: the gate would start passing names this module calls duplicates, and a conflict copy
// would reach tsc again. This test is what keeps them honest.
describe("check-conflict-copies gate agrees with isSyncDuplicateName", () => {
  // Resolved from the repo root rather than relative to dist/, so the assertion does not depend
  // on where the compiled test happens to sit. `npm test` always runs from the root.
  const gatePath = join(process.cwd(), "scripts", "check-conflict-copies.mjs");

  it("classifies every name identically", async () => {
    assert.ok(existsSync(gatePath), `build gate missing at ${gatePath}`);
    const { isConflictCopyName } = await import(pathToFileURL(gatePath).href);

    for (const name of [
      "check-security 2.test.js",
      "triage 2.ts",
      "audit.test 2.js.map",
      "package 2.json",
      "cli 10.js",
      "notes copy.md",
      "notes copy 2.md",
      "types 2.d.ts",
      "check-security.test.js",
      "openai-2.js",
      "es2022.d.ts",
      "top 10 findings.md",
      "sha2 256.js",
      "kit.opencli.json",
    ]) {
      assert.strictEqual(
        isConflictCopyName(name),
        isSyncDuplicateName(name),
        `gate and isSyncDuplicateName disagree on ${name}`,
      );
    }
  });
});
