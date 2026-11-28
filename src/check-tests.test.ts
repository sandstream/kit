import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

// Measured on main: the skip row told users to "set [tests] src_globs" and the header documented a
// `[tests]` table, but nothing in kit reads either. A hint must name something that has an effect.
it("a tree with no source dirs is told what works, not to set an unread [tests] src_globs", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "kit-no-src-dirs-"));
  t.after(() => rmTemp(root));
  const [row] = await checkTests({ cwd: root });
  assert.equal(row.status, "skip");
  assert.doesNotMatch(row.detail, /src_globs|\[tests\]/);
  assert.match(row.detail, /package\.json `workspaces` or pnpm-workspace\.yaml/);
  const header = readFileSync(join(process.cwd(), "src", "check-tests.ts"), "utf8");
  assert.doesNotMatch(header, /src_globs/);
});
