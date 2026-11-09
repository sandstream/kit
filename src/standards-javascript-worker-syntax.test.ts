import assert from "node:assert/strict";
import { test } from "node:test";
import { scan } from "./standards-javascript.test-support.js";

const decisions: [string, string, number][] = [
  ["if", "if (x) go();", 2],
  ["conditional expression", "return x ? 1 : 0;", 2],
  ["for", "for (;;) go();", 2],
  ["for-in", "for (const key in x) go();", 2],
  ["for-of", "for (const value of x) go();", 2],
  ["while", "while (x) go();", 2],
  ["do", "do go(); while (x);", 2],
  ["catch", "try { go(); } catch (error) {}", 2],
  ["switch cases", "switch (x) { case 1: break; case 2: break; default: break; }", 3],
  ["logical operators", "return (x && y || z) ?? a;", 4],
  ["logical assignments", "x &&= y; x ||= y; x ??= y;", 4],
  ["optional access and call", "return x?.y?.[z]?.();", 4],
  ["ordinary assignments", "x = y; return { a: x = 2 };", 1],
];

for (const [name, body, expected] of decisions) {
  test(`measures ${name} through the public JavaScript scanner`, () => {
    const result = scan(`function example(x) { ${body} }`, "input.js");
    assert.equal(result.didNotRun, false, result.issue);
    assert.equal(result.findings.find((finding) => finding.fn === "example")?.ccn, expected);
  });
}

for (const extension of ["js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts", "TS"]) {
  test(`parses the ${extension} source format`, () => {
    const jsx = extension === "jsx" || extension === "tsx";
    const result = scan(
      `const example = (x) => ${jsx ? "<b>{x ? 1 : 0}</b>" : "x ? 1 : 0"};`,
      `input.${extension}`,
    );
    assert.equal(result.didNotRun, false, result.issue);
    assert.equal(result.findings.find((finding) => finding.fn === "example")?.ccn, 2);
  });
}

test("keeps JSX text separate from executable conditions", () => {
  const result = scan(
    'const example = () => <div title="if (x) y || z">if for catch ? &amp;&amp;{x && y}</div>;',
    "input.jsx",
  );
  assert.equal(result.didNotRun, false, result.issue);
  assert.equal(result.findings.find((finding) => finding.fn === "example")?.ccn, 2);
});

test("retains executable conditions inside TypeScript instantiation expressions", () => {
  const source = [
    "function choice<T>() { return 1; }",
    "function hidden(flag: number) {",
    "  return (" +
      Array.from({ length: 15 }, (_, index) => `flag === ${index} ? choice : `).join("") +
      "choice)<number>;",
    "}",
  ].join("\n");
  const control = scan(source.replace(")<number>;", ");"));
  assert.equal(control.didNotRun, false, control.issue);
  assert.equal(control.findings.find((finding) => finding.fn === "hidden")?.ccn, 16);

  const result = scan(source);
  assert.equal(result.didNotRun, false, result.issue);
  assert.equal(result.findings.find((finding) => finding.fn === "hidden")?.ccn, 16);
});

test("retains nested function bodies inside instantiation expressions", () => {
  const result = scan(
    "function outer() { return (function inner<T>(flag: boolean) { return flag ? 1 : 0; })<number>; }",
  );
  assert.equal(result.didNotRun, false, result.issue);
  assert.deepEqual(Object.fromEntries(result.findings.map(({ fn, ccn }) => [fn, ccn])), {
    "<module>": 1,
    outer: 1,
    inner: 2,
  });
});

test("excludes erased types while retaining instantiated runtime expressions", () => {
  const result = scan(
    [
      "function choice<T>() { return 1; }",
      "interface Shape extends Generic<number> { method(): void; }",
      "declare class Ambient { method(): void; }",
      "class Concrete implements Generic<number> {}",
      "function example<T>(flag: boolean) {",
      "  return (flag ? choice : choice)<T extends number ? (() => string) : (() => number)>;",
      "}",
    ].join("\n"),
  );
  assert.equal(result.didNotRun, false, result.issue);
  assert.deepEqual(Object.fromEntries(result.findings.map(({ fn, ccn }) => [fn, ccn])), {
    choice: 1,
    "<module>": 1,
    example: 2,
  });
});

for (const [name, target] of [
  ["a type assertion", "([a = 1] as any)"],
  ["a satisfies check", "([a = 1] satisfies unknown)"],
  ["a non-null assertion", "[a = 1]!"],
] as const) {
  test(`counts a destructuring default behind ${name}`, () => {
    const control = scan("function example(x) { let a; [a = 1] = x; return a; }", "input.ts");
    assert.equal(control.didNotRun, false, control.issue);
    assert.equal(control.findings.find((finding) => finding.fn === "example")?.ccn, 2);

    const result = scan(`function example(x) { let a; ${target} = x; return a; }`, "input.ts");
    assert.equal(result.didNotRun, false, result.issue);
    assert.equal(result.findings.find((finding) => finding.fn === "example")?.ccn, 2);
  });
}
