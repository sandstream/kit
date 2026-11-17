import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findJunkTests,
  runJunkTestsAudit,
  selfComparison,
  testBlocks,
} from "./self-audit-junk-tests.js";

// The fixtures are assembled from pieces so that this file does not itself read as the
// patterns it tests: R18 scans every `src/**/*.test.ts`, this one included.
const IT = "it";
const A = "assert";
const E = "expect";
const lines = (...l: string[]): string => l.join("\n");
const noImports = (): string => "";

describe("selfComparison", () => {
  it("flags a constant truth", () => {
    assert.match(selfComparison(`${A}.ok(true);`) ?? "", /constant `true`/);
    assert.match(selfComparison(`${A}(true, "why");`) ?? "", /constant `true`/);
    assert.match(selfComparison(`${E}(true).toBe(true);`) ?? "", /constant `true`/);
  });

  it("flags a value compared with itself", () => {
    assert.match(selfComparison(`${A}.equal(result, result);`) ?? "", /with itself/);
    assert.match(selfComparison(`${A}.deepEqual(a.b[0], a.b[0], "msg");`) ?? "", /with itself/);
    assert.match(selfComparison(`${E}(x.y).toEqual(x.y);`) ?? "", /with itself/);
  });

  it("leaves a determinism check and an ordinary comparison alone", () => {
    assert.equal(selfComparison(`${A}.equal(f(x), f(x));`), null);
    assert.equal(selfComparison(`${A}.equal(result, expected);`), null);
    assert.equal(selfComparison(`${A}.ok(value);`), null);
    assert.equal(selfComparison(`${A}.equal(trueish, true);`), null);
  });
});

describe("testBlocks", () => {
  it("reads the title and the call after it, through strings and templates with braces", () => {
    const src = lines(
      `${IT}("first", () => {`,
      "  const s = `a ${'{'} b`; // }",
      `  ${A}.equal(s, "}");`,
      "});",
      `${IT}("second", () => fixture(["x"], async (d) => use(d)));`,
    );
    const blocks = testBlocks(src);
    assert.deepEqual(
      blocks.map((b) => [b.line, b.title]),
      [
        [1, "first"],
        [5, "second"],
      ],
    );
    assert.match(blocks[1].body, /fixture\(\["x"\]/);
  });
});

describe("findJunkTests", () => {
  it("finds a test that asserts nothing", () => {
    const src = lines(`${IT}("runs", () => {`, "  doWork();", "});");
    assert.deepEqual(
      findJunkTests(src, noImports).map((f) => f.kind),
      ["assertion-free"],
    );
  });

  it("counts a call to a helper that asserts, in the file or imported, as an assertion", () => {
    const local = lines(
      `function check(x: number) { ${A}.equal(x, 1); }`,
      "const viaArrow = (x: number) => check(x);",
      `${IT}("uses a helper", () => {`,
      "  viaArrow(1);",
      "});",
    );
    assert.deepEqual(findJunkTests(local, noImports), []);
    const imported = lines(
      'import { blocks } from "./gate.test-support.js";',
      `${IT}("uses an imported helper", () => blocks("npm i x"));`,
    );
    const support = `export function blocks(c: string) { ${A}.ok(run(c)); }`;
    assert.deepEqual(
      findJunkTests(imported, () => support),
      [],
    );
    assert.equal(findJunkTests(imported, noImports)[0]?.kind, "assertion-free");
  });

  it("does not take the word throw in a title as an assertion", () => {
    const src = lines(`${IT}("does not throw", () => {`, "  parse(input);", "});");
    assert.equal(findJunkTests(src, noImports)[0]?.kind, "assertion-free");
  });

  it("finds a test repeated word for word, but not a loop or different fixtures", () => {
    const body = `  ${A}.equal(f(), 1);`;
    const repeated = lines(
      `${IT}("one", () => {`,
      body,
      "});",
      `${IT}("two", () => {`,
      body,
      "});",
    );
    const found = findJunkTests(repeated, noImports);
    assert.deepEqual(
      found.map((f) => [f.kind, f.line]),
      [["duplicate", 4]],
    );
    assert.match(found[0].detail, /same body as "one" \(line 1\)/);

    const fixtures = lines(
      `${IT}("a", () => inDir(["x"], (d) => ${A}.ok(has(d))));`,
      `${IT}("b", () => inDir(["y"], (d) => ${A}.ok(has(d))));`,
    );
    assert.deepEqual(findJunkTests(fixtures, noImports), []);

    const loop = lines(
      "for (const c of cases) {",
      `  ${IT}(\`case \${c}\`, () => ${A}.ok(c));`,
      `  ${IT}(\`again \${c}\`, () => ${A}.ok(c));`,
      "}",
    );
    assert.deepEqual(findJunkTests(loop, noImports), []);
  });
});

describe("runJunkTestsAudit", () => {
  it("reports each finding with its file and line, and passes a clean tree", (t) => {
    const root = mkdtempSync(join(tmpdir(), "kit-junk-tests-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, "src", "sub"), { recursive: true });
    writeFileSync(
      join(root, "src", "sub", "a.test.ts"),
      lines(`${IT}("x", () => {`, "  go();", "});"),
    );
    writeFileSync(join(root, "src", "b.test.ts"), `${IT}("y", () => ${A}.ok(go()));`);
    const results = runJunkTestsAudit(root, "junk-pattern tests");
    assert.equal(results.length, 1);
    assert.equal(results[0].status, "fail");
    assert.deepEqual(results[0].files, ["src/sub/a.test.ts:1"]);
    assert.match(results[0].detail, /^assertion-free: test "x" asserts nothing/);

    writeFileSync(join(root, "src", "sub", "a.test.ts"), `${IT}("x", () => ${A}.ok(go()));`);
    assert.deepEqual(
      runJunkTestsAudit(root, "junk-pattern tests").map((r) => r.status),
      ["pass"],
    );
  });
});
