import { describe, it } from "node:test";
import assert from "node:assert";
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
