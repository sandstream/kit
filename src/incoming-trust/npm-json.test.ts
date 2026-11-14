import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseNpmObject } from "./npm-json.js";

const bytes = (text: string) => new TextEncoder().encode(text);
const codes = (result: ReturnType<typeof parseNpmObject>) =>
  "issues" in result ? result.issues.map((i) => i.code) : [];

describe("parseNpmObject", () => {
  it("returns the object of a valid document", () => {
    const result = parseNpmObject(bytes('{"name":"a","nested":{"name":"b"}}'), 1024);
    assert.deepEqual("value" in result && result.value, { name: "a", nested: { name: "b" } });
  });

  it("refuses an input over the byte limit before decoding it", () => {
    assert.deepEqual(codes(parseNpmObject(bytes("{}"), 1)), ["input-limit"]);
  });

  it("refuses bytes that are not UTF-8", () => {
    assert.deepEqual(codes(parseNpmObject(new Uint8Array([0x7b, 0xff, 0x7d]), 1024)), [
      "invalid-utf8",
    ]);
  });

  it("refuses text that is not JSON", () => {
    assert.deepEqual(codes(parseNpmObject(bytes("{nope"), 1024)), ["invalid-json"]);
  });

  it("refuses a duplicate key, also when the duplicate is nested", () => {
    assert.deepEqual(codes(parseNpmObject(bytes('{"a":1,"a":2}'), 1024)), ["duplicate-json-key"]);
    assert.deepEqual(codes(parseNpmObject(bytes('{"x":{"a":1,"a":2}}'), 1024)), [
      "duplicate-json-key",
    ]);
  });

  it("accepts the same key in sibling objects", () => {
    assert.ok("value" in parseNpmObject(bytes('{"x":{"a":1},"y":{"a":2}}'), 1024));
  });

  it("refuses a top level that is not an object", () => {
    assert.deepEqual(codes(parseNpmObject(bytes("[1]"), 1024)), ["invalid-schema"]);
    assert.deepEqual(codes(parseNpmObject(bytes("null"), 1024)), ["invalid-schema"]);
  });

  it("refuses nesting deeper than 128 levels", () => {
    const deep = '{"a":'.repeat(130) + "1" + "}".repeat(130);
    assert.ok(codes(parseNpmObject(bytes(deep), 1024 * 1024)).includes("input-limit"));
  });
});
