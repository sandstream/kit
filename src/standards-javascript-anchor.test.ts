import assert from "node:assert/strict";
import { test } from "node:test";
import { complexityKey, complexityMetricKey } from "./check-standards.js";
import { scan } from "./standards-javascript.test-support.js";

const branches = (name: string, count: number): string =>
  `function ${name}(x) {\n` +
  Array.from({ length: count }, (_, n) => `  if (x === ${n}) return ${n};\n`).join("") +
  "  return -1;\n}\n";

function keyOf(source: string, fn: string, nth = 0): string {
  const result = scan(source, "input.ts");
  assert.equal(result.didNotRun, false, result.issue);
  const found = result.findings.filter((finding) => finding.fn === fn);
  assert.ok(found[nth], `no ${fn} #${nth} in ${JSON.stringify(result.findings)}`);
  return complexityKey(found[nth]);
}

test("keeps a function's baseline key when only text above it changes", () => {
  const plain = keyOf(branches("big", 16), "big");
  assert.equal(keyOf("// a note\n" + branches("big", 16), "big"), plain);
  assert.equal(keyOf(branches("small", 1) + branches("big", 16), "big"), plain);
});

test("does not let a different function at the same position inherit the key", () => {
  assert.notEqual(keyOf(branches("other", 16), "other"), keyOf(branches("big", 16), "big"));
});

test("gives two bodies with one name in one file different keys, in source order", () => {
  const source =
    "class A { run(x) { return x ? 1 : 0; } }\nclass B { run(x) { return x ? 1 : 0; } }\n";
  const first = keyOf(source, "run", 0);
  const second = keyOf(source, "run", 1);
  assert.notEqual(first, second);
  assert.equal(keyOf("// moved down\n" + source, "run", 0), first);
});

test("keeps the frozen magnitude tied to the same key", () => {
  const result = scan(branches("big", 16), "input.ts");
  const big = result.findings.find((finding) => finding.fn === "big");
  assert.ok(big);
  assert.equal(complexityMetricKey(big), `${complexityKey(big)}|ccn=17|length=${big.length}`);
});

test("keeps an anonymous function's key when only text above it changes", () => {
  const callback =
    "run(() => {\n" +
    Array.from({ length: 16 }, (_, n) => `  if (x === ${n}) return ${n};\n`).join("") +
    "  return -1;\n});\n";
  const anonymous = (source: string): string => {
    const result = scan(source, "input.ts");
    assert.equal(result.didNotRun, false, result.issue);
    const found = result.findings.filter((finding) => finding.ccn === 17);
    assert.equal(found.length, 1, JSON.stringify(result.findings));
    return complexityKey(found[0]);
  };
  const plain = anonymous(callback);
  assert.doesNotMatch(plain, /@\d+/);
  assert.equal(anonymous("// a note\n" + callback), plain);
  assert.equal(anonymous(branches("named", 1) + callback), plain);
});

test("anchors an anonymous callback to the call it is passed to, not to its order in the file", () => {
  const callback = (title: string, count: number): string =>
    `describe("${title}", () => {\n` +
    Array.from({ length: count }, (_, n) => `  if (x === ${n}) return ${n};\n`).join("") +
    "  return -1;\n});\n";
  const keys = (source: string): string[] => {
    const result = scan(source, "input.ts");
    assert.equal(result.didNotRun, false, result.issue);
    return result.findings.filter((finding) => finding.ccn === 17).map(complexityKey);
  };
  const [plain] = keys(callback("large", 16));
  assert.deepEqual(keys(callback("small", 1) + callback("large", 16)), [plain]);
  assert.deepEqual(keys(callback("large", 16) + callback("small", 1)), [plain]);
  const [other] = keys(callback("another", 16));
  assert.notEqual(other, plain);
  const twice = keys(callback("large", 16) + callback("large", 16));
  assert.equal(twice.length, 2);
  assert.equal(twice[0], plain);
  assert.notEqual(twice[1], plain);
});
