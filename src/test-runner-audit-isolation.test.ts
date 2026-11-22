import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { rmTemp } from "./temp-cleanup.test-support.js";

const scripts = join(import.meta.dirname, "..", "scripts");

function runnerFixture(t: TestContext): { root: string; ambient: string } {
  const root = mkdtempSync(join(tmpdir(), "kit-runner-isolation-"));
  t.after(() => rmTemp(root));
  mkdirSync(join(root, "scripts"));
  for (const file of ["test.mjs", "test-shard.mjs", "test-failure-kinds.mjs"]) {
    copyFileSync(join(scripts, file), join(root, "scripts", file));
  }
  mkdirSync(join(root, "dist", "utils"), { recursive: true });
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  // There is one compiled fixture with a valid name.
  writeFileSync(
    join(root, "dist", "utils", "sync-duplicate.js"),
    "export const isSyncDuplicateName = () => false;",
  );
  writeFileSync(
    join(root, "dist", "observe.test.js"),
    `
      import assert from "node:assert/strict";
      import { existsSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      import { test } from "node:test";
      test("records the supplied anchor directory", () => {
        const dir = process.env.KIT_AUDIT_ANCHOR_DIR;
        writeFileSync("observed.txt", dir);
        assert.ok(existsSync(dir));
        assert.equal(process.env.KIT_AUDIT_ANCHOR, "0");
        assert.equal(existsSync(join(dir, "caller-marker")), false);
        writeFileSync(join(dir, "test-output"), "temporary state");
        assert.equal(process.env.KIT_FIXTURE_FAIL, "0", "intentional fixture failure");
      });
    `,
  );
  const ambient = join(root, "caller-anchor");
  mkdirSync(ambient);
  writeFileSync(join(ambient, "caller-marker"), "preserve this");
  return { root, ambient };
}

for (const status of [0, 1]) {
  test(`the test runner isolates the audit index and cleans up on exit ${status}`, (t) => {
    const { root, ambient } = runnerFixture(t);
    const run = spawnSync(process.execPath, [join(root, "scripts", "test.mjs")], {
      cwd: root,
      env: {
        ...process.env,
        KIT_AUDIT_ANCHOR_DIR: ambient,
        KIT_TEST_SHARD: "",
        KIT_TEST_CONCURRENCY: "1",
        KIT_TEST_TIMEOUT_MS: undefined,
        NODE_TEST_CONTEXT: undefined,
        KIT_FIXTURE_FAIL: String(status),
      },
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.ifError(run.error);
    assert.equal(run.status, status, run.stderr + run.stdout);
    if (status === 1) assert.match(run.stdout, /intentional fixture failure/);
    const observed = readFileSync(join(root, "observed.txt"), "utf8");
    assert.notEqual(observed, ambient);
    assert.equal(existsSync(observed), false);
    assert.equal(readFileSync(join(ambient, "caller-marker"), "utf8"), "preserve this");
  });
}
