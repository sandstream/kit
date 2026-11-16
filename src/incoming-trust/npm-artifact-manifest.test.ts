import assert from "node:assert/strict";
import { it } from "node:test";
import { inspectNpmManifest } from "./npm-artifact-manifest.js";

const expected = { name: "@scope/real", version: "1.2.3" };

it("checks the real manifest identity and returns scripts as data", () => {
  const bytes = Buffer.from(
    '{"name":"@scope/real","version":"1.2.3","scripts":{"install":"node install.js"},"description":"ordinary metadata"}',
  );
  assert.deepEqual(inspectNpmManifest(bytes, expected), {
    status: "verified",
    ...expected,
    scripts: { install: "node install.js" },
  });
});

it("requires an exact name and version and preserves absence of scripts", () => {
  assert.deepEqual(inspectNpmManifest(Buffer.from(JSON.stringify(expected)), expected), {
    status: "verified",
    ...expected,
    scripts: {},
  });
  for (const identity of [
    { name: "compat", version: "1.2.3" },
    { name: "@scope/real", version: "1.2.4" },
    { name: "@scope/real", version: "v1.2.3" },
    { name: "@scope/real", version: "1.2.3 " },
  ]) {
    assert.deepEqual(inspectNpmManifest(Buffer.from(JSON.stringify(identity)), expected), {
      status: "rejected",
      reason: "manifest-identity-mismatch",
    });
  }
});

it("rejects nonobject manifests and invalid script maps instead of returning success", () => {
  for (const value of [null, [], true, 1, "value"]) {
    assert.deepEqual(inspectNpmManifest(Buffer.from(JSON.stringify(value)), expected), {
      status: "rejected",
      reason: "invalid-manifest-schema",
    });
  }
  for (const scripts of [null, [], false, "node install.js", { install: 1 }, { prepare: {} }]) {
    assert.deepEqual(
      inspectNpmManifest(Buffer.from(JSON.stringify({ ...expected, scripts })), expected),
      {
        status: "rejected",
        reason: "invalid-manifest-scripts",
      },
    );
  }
});

it("rejects malformed JSON, invalid UTF-8, and duplicate keys at any object depth", () => {
  for (const text of ["", "{", '{"name":', JSON.stringify(expected) + "{}", "/* comment */{}"]) {
    assert.deepEqual(inspectNpmManifest(Buffer.from(text), expected), {
      status: "rejected",
      reason: "invalid-manifest-json",
    });
  }
  const invalidUtf8 = Buffer.concat([
    Buffer.from('{"name":"@scope/real","version":"1.2.3","description":"'),
    Buffer.from([0xc3, 0x28]),
    Buffer.from('"}'),
  ]);
  assert.deepEqual(inspectNpmManifest(invalidUtf8, expected), {
    status: "rejected",
    reason: "invalid-manifest-utf8",
  });
  for (const content of [
    '{"name":"wrong","name":"@scope/real","version":"1.2.3"}',
    '{"name":"@scope/real","version":"9.9.9","version":"1.2.3"}',
    '{"name":"@scope/real","version":"1.2.3","scripts":{"install":"one","install":"two"}}',
    '{"name":"@scope/real","version":"1.2.3","x":[{"a":1,"\\u0061":2}]}',
  ]) {
    assert.deepEqual(inspectNpmManifest(Buffer.from(content), expected), {
      status: "rejected",
      reason: "duplicate-manifest-key",
    });
  }
  const content = JSON.stringify({
    ...expected,
    first: { a: 1 },
    second: { a: 2 },
    text: '"a":1,"a":2{}[]',
  });
  assert.equal(inspectNpmManifest(Buffer.from(content), expected).status, "verified");
});

it("bounds manifest bytes and JSON nesting at their inclusive limits", () => {
  const base = JSON.stringify(expected);
  const max = 1024 * 1024;
  for (const length of [max - 1, max]) {
    assert.equal(inspectNpmManifest(Buffer.from(base.padEnd(length)), expected).status, "verified");
  }
  assert.deepEqual(inspectNpmManifest(Buffer.from(base.padEnd(max + 1)), expected), {
    status: "unsupported",
    reason: "manifest-limit",
  });
  for (const depth of [127, 128, 129]) {
    const content =
      base.slice(0, -1) + ',"extra":' + "[".repeat(depth - 1) + "0" + "]".repeat(depth - 1) + "}";
    const result = inspectNpmManifest(Buffer.from(content), expected);
    assert.equal(result.status, depth <= 128 ? "verified" : "unsupported");
    if (result.status !== "verified") assert.equal(result.reason, "manifest-limit");
  }
});

it("refuses invalid byte and expected-identity inputs without coercion", () => {
  for (const bytes of [undefined, null, "{}", [123, 125], new Uint8Array([123, 125])]) {
    assert.deepEqual(Reflect.apply(inspectNpmManifest, undefined, [bytes, expected]), {
      status: "rejected",
      reason: "invalid-manifest-bytes",
    });
  }
  for (const identity of [
    null,
    [],
    {},
    { name: null, version: "1.2.3" },
    { name: "@scope/real", version: 123 },
    { name: "@scope/real", version: "" },
  ]) {
    assert.deepEqual(
      Reflect.apply(inspectNpmManifest, undefined, [
        Buffer.from(JSON.stringify(expected)),
        identity,
      ]),
      {
        status: "rejected",
        reason: "invalid-expected-identity",
      },
    );
  }
});

it("does not accept missing or incorrectly typed manifest identity fields", () => {
  for (const manifest of [
    {},
    { ...expected, name: null },
    { ...expected, version: 123 },
    { ...expected, name: "" },
    { ...expected, version: "" },
  ]) {
    assert.deepEqual(inspectNpmManifest(Buffer.from(JSON.stringify(manifest)), expected), {
      status: "rejected",
      reason: "invalid-manifest-schema",
    });
  }
});

it("keeps script names as own data properties and does not retain the caller's bytes", () => {
  const bytes = Buffer.from(
    '{"name":"@scope/real","version":"1.2.3","scripts":{"__proto__":"literal","constructor":"also literal","empty":""}}',
  );
  const result = inspectNpmManifest(bytes, expected);
  assert.equal(result.status, "verified");
  if (result.status !== "verified") return;
  assert.deepEqual(Object.keys(result.scripts), ["__proto__", "constructor", "empty"]);
  assert.equal(Object.getPrototypeOf(result.scripts), Object.prototype);
  assert.equal(Object.getOwnPropertyDescriptor(result.scripts, "__proto__")?.value, "literal");
  const evidence = JSON.stringify(result);
  bytes.fill(0);
  assert.equal(JSON.stringify(result), evidence);
});

it("accepts one UTF-8 BOM but refuses a second BOM and embedded malformed bytes", () => {
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  const content = Buffer.from(JSON.stringify(expected));
  assert.equal(inspectNpmManifest(Buffer.concat([bom, content]), expected).status, "verified");
  assert.deepEqual(inspectNpmManifest(Buffer.concat([bom, bom, content]), expected), {
    status: "rejected",
    reason: "invalid-manifest-json",
  });
  assert.deepEqual(inspectNpmManifest(Buffer.concat([content, Buffer.from([0xff])]), expected), {
    status: "rejected",
    reason: "invalid-manifest-utf8",
  });
});
