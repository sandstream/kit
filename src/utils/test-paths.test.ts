import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { isTestOrFixturePath } from "./test-paths.js";

// This predicate decides whether a secret-shaped string BLOCKS a commit or is reported
// as an advisory, so both directions are security-relevant: too broad and a real staged
// credential slips through under a test-ish path, too narrow and kit blocks its own
// redaction tests and trains developers to reach for --no-verify.

describe("isTestOrFixturePath", () => {
  it("matches the filename conventions for tests", () => {
    for (const p of [
      "src/audit.test.ts",
      "src/audit.spec.ts",
      "src/utils/flags.test.ts",
      "packages/adapter-sdk/src/x.test.ts",
    ]) {
      assert.equal(isTestOrFixturePath(p), true, p);
    }
  });

  it("matches the directory conventions", () => {
    for (const p of [
      "src/__tests__/thing.ts",
      "src/__mocks__/fs.ts",
      "test/fixtures/token.txt",
      "src/fixture/sample.json",
      "src/fixtures/sample.json",
      "src/data.fixture.ts",
    ]) {
      assert.equal(isTestOrFixturePath(p), true, p);
    }
  });

  it("normalises Windows separators so the rule is the same on either OS", () => {
    assert.equal(isTestOrFixturePath("src\\__mocks__\\fs.ts"), true);
    assert.equal(isTestOrFixturePath("test\\fixtures\\token.txt"), true);
  });

  it("does NOT match ordinary source, so a real staged secret still blocks", () => {
    // The failure that matters: anything here returning true would let a live credential
    // through the pre-commit gate as a mere advisory.
    for (const p of [
      "src/audit.ts",
      "src/secrets.ts",
      "src/commands/check.ts",
      ".env",
      ".env.local",
      "config/production.json",
      "scripts/deploy.mjs",
      "README.md",
    ]) {
      assert.equal(isTestOrFixturePath(p), false, p);
    }
  });

  it("is not fooled by a directory merely NAMED after testing", () => {
    // `testing-utils` and `latest/` are real code. Loosening the pattern to a bare
    // "test" substring would exempt both.
    for (const p of [
      "src/testing-utils/helper.ts",
      "src/latest/index.ts",
      "src/contest.ts",
      "src/protest/handler.ts",
    ]) {
      assert.equal(isTestOrFixturePath(p), false, p);
    }
  });

  it("requires the dots around .test. — a file merely starting with test is source", () => {
    assert.equal(isTestOrFixturePath("src/testhelpers.ts"), false);
    assert.equal(isTestOrFixturePath("src/test.ts"), false);
  });

  it("handles an empty path without throwing", () => {
    assert.equal(isTestOrFixturePath(""), false);
  });
});
