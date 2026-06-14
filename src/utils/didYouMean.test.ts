import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { levenshtein, didYouMean } from "./didYouMean.js";

describe("levenshtein", () => {
  it("returns 0 for identical strings", () => {
    assert.equal(levenshtein("check", "check"), 0);
  });

  it("counts single substitution", () => {
    assert.equal(levenshtein("check", "chick"), 1);
  });

  it("counts transposition as 2 (no Damerau)", () => {
    assert.equal(levenshtein("chekc", "check"), 2);
  });

  it("handles empty strings", () => {
    assert.equal(levenshtein("", "abc"), 3);
    assert.equal(levenshtein("abc", ""), 3);
  });
});

describe("didYouMean", () => {
  const COMMANDS = ["check", "secrets", "security", "setup", "init", "fix", "hooks", "triage"];

  it("suggests check for chekc", () => {
    assert.deepEqual(didYouMean("chekc", COMMANDS)[0], "check");
  });

  it("suggests secrets for screts", () => {
    assert.deepEqual(didYouMean("screts", COMMANDS)[0], "secrets");
  });

  it("suggests security for securty", () => {
    assert.deepEqual(didYouMean("securty", COMMANDS)[0], "security");
  });

  it("returns empty for gibberish", () => {
    assert.deepEqual(didYouMean("xyzzyqwerty", COMMANDS), []);
  });

  it("never suggests the exact same string (distance 0 excluded)", () => {
    assert.deepEqual(didYouMean("check", COMMANDS), []);
  });

  it("is case-insensitive", () => {
    assert.equal(didYouMean("CHEKC", COMMANDS)[0], "check");
  });

  it("caps suggestions at 3", () => {
    const many = ["aaa", "aab", "aba", "baa", "abb"];
    assert.ok(didYouMean("aax", many).length <= 3);
  });
});
