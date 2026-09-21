import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findUntestedSources } from "./check-tests.js";

it("coverage inventory separates test support from production sources without hiding similarly named modules", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "kit-test-support-coverage-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
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
