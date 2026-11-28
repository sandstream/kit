import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkTests, findUntestedSources } from "./check-tests.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

it("coverage inventory separates test support from production sources without hiding similarly named modules", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "kit-test-support-coverage-"));
  t.after(() => rmTemp(root));
  mkdirSync(join(root, "src"));
  for (const file of [
    "app.ts",
    "app.test.ts",
    "fixture.test-support.ts",
    "fixture.test-support.js",
    "test-support-client.ts",
  ]) {
    writeFileSync(join(root, "src", file), "export {};\n");
  }
  assert.deepEqual(await findUntestedSources(root), [join("src", "test-support-client.ts")]);
});

// Measured: a src/ holding only index.js (excluded by default) passed with "every source file has a
// sibling .test file". Zero counted makes that sentence vacuous; the row must say what was found.
async function coverageOf(files: string[]) {
  const root = mkdtempSync(join(tmpdir(), "kit-zero-coverage-"));
  mkdirSync(join(root, "src"));
  for (const f of files) writeFileSync(join(root, "src", f), "export {};\n");
  try {
    return (await checkTests({ cwd: root })).find((r) => r.name === "unit-test coverage")!;
  } finally {
    rmTemp(root);
  }
}

it("zero source files counted is not a pass, and the row names what it found", async () => {
  const row = await coverageOf(["index.js"]);
  assert.notEqual(row.status, "pass", row.detail);
  assert.doesNotMatch(row.detail, /every source file/);
  assert.match(row.detail, /no source files counted: 1 \.ts\/\.js file\(s\) in src.*index\.js/);
});

it("an empty src/ says it found no files", async () => {
  const row = await coverageOf([]);
  assert.equal(row.status, "skip");
  assert.match(row.detail, /no source files counted: no \.ts\/\.js files in src/);
});

it("a pass states how many files it counted", async () => {
  const row = await coverageOf(["app.ts", "app.test.ts", "index.ts"]);
  assert.equal(row.status, "pass");
  assert.match(row.detail, /every source file has a sibling \.test file \(1 counted\)/);
});
