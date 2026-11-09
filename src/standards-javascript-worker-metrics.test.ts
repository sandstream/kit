import assert from "node:assert/strict";
import { test } from "node:test";
import { scan } from "./standards-javascript.test-support.js";

test("assigns nested functions their own decisions and excludes conditional types", () => {
  const result = scan(
    "type P<T> = T extends number ? (() => void) : never; function outer(x: number = 1) { const inner = (y: number = 2) => y ? 1 : 0; if(x) return inner(x); return 0; }",
  );
  assert.equal(result.didNotRun, false, result.issue);
  assert.deepEqual(
    result.findings.map(({ fn, ccn }) => [fn, ccn]),
    [
      ["<module>", 1],
      ["outer", 3],
      ["inner", 3],
    ],
  );
});

test("measures class evaluation, methods, constructors, accessors and initializers separately", () => {
  const result = scan(
    "class C extends (flag ? A : B) { [key || 'm'](x = 0) { return x?.value; } field = ready && 1; static { if (ready) go(); } constructor(x = 0) {} get value() { return ready ? 1 : 0; } set value(x) { if(x) go(); } }",
  );
  assert.equal(result.didNotRun, false, result.issue);
  assert.deepEqual(
    result.findings.map(({ fn, ccn }) => [fn, ccn]),
    [
      ["<module>", 3],
      ["[computed]", 3],
      ["field", 2],
      ["static block", 2],
      ["constructor", 2],
      ["get value", 2],
      ["set value", 2],
    ],
  );
});

test("counts defaults without treating ordinary assignments as decisions", () => {
  const result = scan(
    "function defaults({a=1} = {}, [b=2] = [], c=3) { const {d=4}=obj; let e; [e=5]=items; ({f:e=6}=obj); ({e=7}=obj); const expression=[e=8]; e=9; }",
  );
  assert.equal(result.didNotRun, false, result.issue);
  assert.equal(result.findings.find((finding) => finding.fn === "defaults")?.ccn, 10);
});

test("retains distinct identities for methods with the same name", () => {
  const result = scan("const a={ same(){ if(x) go(); } }; const b={ same(){ while(x) go(); } };");
  assert.equal(result.didNotRun, false, result.issue);
  const methods = result.findings.filter((finding) => finding.fn === "same");
  assert.equal(methods.length, 2);
  assert.ok(methods.every((finding) => finding.ccn === 2));
  assert.notEqual(methods[0].identity, methods[1].identity);
});

test("counts physical lines correctly with Unicode and CRLF input", () => {
  const result = scan('const emoji="😀";\r\nfunction example() {\r\n if (x) go();\r\n}\r\n');
  assert.equal(result.didNotRun, false, result.issue);
  const body = result.findings.find((finding) => finding.fn === "example");
  assert.equal(body?.ccn, 2);
  assert.equal(body?.length, 3);
});
