import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shellSplit } from "./shellSplit.js";

describe("shellSplit", () => {
  it("splits plain words on any whitespace run", () => {
    assert.deepEqual(shellSplit("pnpm test --watch"), ["pnpm", "test", "--watch"]);
    assert.deepEqual(shellSplit("  a\t b \n c "), ["a", "b", "c"]);
    assert.deepEqual(shellSplit(""), []);
  });

  it("keeps a double-quoted argument as ONE token (the naive-split bug)", () => {
    assert.deepEqual(shellSplit('git commit -m "a b c"'), ["git", "commit", "-m", "a b c"]);
    // vs. the naive split which would produce 6 tokens:
    assert.notDeepEqual('git commit -m "a b c"'.split(/\s+/), shellSplit('git commit -m "a b c"'));
  });

  it("treats single quotes as literal (no escapes inside)", () => {
    assert.deepEqual(shellSplit("echo 'a \"b\" c'"), ["echo", 'a "b" c']);
    assert.deepEqual(shellSplit("echo 'it\\'"), ["echo", "it\\"]); // backslash literal in single quotes
  });

  it("honors backslash escapes outside and inside double quotes", () => {
    assert.deepEqual(shellSplit("a\\ b"), ["a b"]); // escaped space → one token
    assert.deepEqual(shellSplit('x "a\\"b"'), ["x", 'a"b']); // \" inside double quotes
    assert.deepEqual(shellSplit('"a\\\\b"'), ["a\\b"]); // \\ → one backslash
  });

  it("preserves an explicitly empty quoted argument", () => {
    assert.deepEqual(shellSplit('foo "" bar'), ["foo", "", "bar"]);
    assert.deepEqual(shellSplit("foo '' bar"), ["foo", "", "bar"]);
  });

  it("throws on an unterminated quote (caller refuses rather than mis-splits)", () => {
    assert.throws(() => shellSplit('git commit -m "oops'), /unterminated double quote/);
    assert.throws(() => shellSplit("echo 'oops"), /unterminated single quote/);
  });
});
