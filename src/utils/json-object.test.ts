import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseJsonObject } from "./json-object.js";

const bytes = (text: string) => new TextEncoder().encode(text);
const codes = (result: ReturnType<typeof parseJsonObject>) =>
  "issues" in result ? result.issues.map((i) => i.code) : [];

describe("parseJsonObject", () => {
  it("returns the object of a valid document", () => {
    const result = parseJsonObject(bytes('{"name":"a","nested":{"name":"b"}}'), 1024);
    assert.deepEqual("value" in result && result.value, { name: "a", nested: { name: "b" } });
  });

  it("refuses an input over the byte limit before decoding it", () => {
    assert.deepEqual(codes(parseJsonObject(bytes("{}"), 1)), ["input-limit"]);
  });

  it("refuses bytes that are not UTF-8", () => {
    assert.deepEqual(codes(parseJsonObject(new Uint8Array([0x7b, 0xff, 0x7d]), 1024)), [
      "invalid-utf8",
    ]);
  });

  it("refuses text that is not JSON", () => {
    assert.deepEqual(codes(parseJsonObject(bytes("{nope"), 1024)), ["invalid-json"]);
  });

  it("refuses a duplicate key, also when the duplicate is nested", () => {
    assert.deepEqual(codes(parseJsonObject(bytes('{"a":1,"a":2}'), 1024)), ["duplicate-json-key"]);
    assert.deepEqual(codes(parseJsonObject(bytes('{"x":{"a":1,"a":2}}'), 1024)), [
      "duplicate-json-key",
    ]);
  });

  it("accepts the same key in sibling objects", () => {
    assert.ok("value" in parseJsonObject(bytes('{"x":{"a":1},"y":{"a":2}}'), 1024));
  });

  it("refuses a top level that is not an object", () => {
    assert.deepEqual(codes(parseJsonObject(bytes("[1]"), 1024)), ["invalid-schema"]);
    assert.deepEqual(codes(parseJsonObject(bytes("null"), 1024)), ["invalid-schema"]);
  });

  it("accepts 128 levels and refuses level 129 in objects and arrays", () => {
    const object = (depth: number) => '{"a":'.repeat(depth) + "1" + "}".repeat(depth);
    const arrays = (depth: number) =>
      '{"items":' + "[".repeat(depth - 1) + "1" + "]".repeat(depth - 1) + "}";
    for (const nested of [object, arrays]) {
      assert.ok("value" in parseJsonObject(bytes(nested(128)), 1024 * 1024));
      assert.deepEqual(codes(parseJsonObject(bytes(nested(129)), 1024 * 1024)), ["input-limit"]);
    }
  });
});
