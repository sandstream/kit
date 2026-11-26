import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CURL_GLOB_MAX, expandCurlGlob } from "./curl-glob.js";

describe("expandCurlGlob", () => {
  it("expands curl's ranges and sets in curl's order", () => {
    const cases: [string, string[]][] = [
      ["h[1-3].example", ["h1.example", "h2.example", "h3.example"]],
      ["10.0.0.[1-3]", ["10.0.0.1", "10.0.0.2", "10.0.0.3"]],
      ["{a,b}.example", ["a.example", "b.example"]],
      ["x[a-c]", ["xa", "xb", "xc"]],
      ["[A-B]", ["A", "B"]],
      ["f[01-10:3]", ["f01", "f04", "f07", "f10"]],
      ["{a,b}[1-2]", ["a1", "a2", "b1", "b2"]],
      ["{,www.}h.example", ["h.example", "www.h.example"]],
    ];
    for (const [word, expected] of cases) assert.deepEqual(expandCurlGlob(word), expected, word);
  });

  it("leaves a word with no pattern, an IPv6 address and an escaped bracket literal", () => {
    assert.deepEqual(expandCurlGlob("https://h.example/x?y=1"), ["https://h.example/x?y=1"]);
    assert.deepEqual(expandCurlGlob("[::1]:3000/x"), ["[::1]:3000/x"]);
    assert.deepEqual(expandCurlGlob("http://[2001:db8::1]/"), ["http://[2001:db8::1]/"]);
    assert.deepEqual(expandCurlGlob("h.example/\\[1-2\\]\\{a\\}"), ["h.example/[1-2]{a}"]);
    assert.deepEqual(expandCurlGlob("a\\b"), ["a\\b"]);
  });

  it("is unreadable (null) past the bound or when malformed", () => {
    assert.equal(expandCurlGlob("[1-8][1-8]")?.length, CURL_GLOB_MAX);
    for (const word of [
      "h[1-65].example",
      "[1-8][1-9]",
      "[0-999999999]",
      "{a,b",
      "a}",
      "a]",
      "{a,{b}}",
      "{a,[1-2]}",
      "[5-1]",
      "[a-Z]",
      "[1-3:0]",
      "[x]",
    ]) {
      assert.equal(expandCurlGlob(word), null, word);
    }
  });
});
