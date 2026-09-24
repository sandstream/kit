import { it } from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { MONKEY_HARNESS_FILES } from "./monkey-test-contract.js";
import { writeMonkeyHarness } from "./monkey-test-harness.js";

it("refuses symlink and directory destinations even during forced refresh", async () => {
  const root = await mkdtemp(join(tmpdir(), "kit-monkey-harness-destinations-"));
  try {
    assert.equal((await writeMonkeyHarness(root)).ok, true);
    const target = join(root, "operator.ts");
    const spec = join(root, "tests/monkey/monkey.spec.ts");
    const generated = await readFile(spec, "utf8");
    await writeFile(target, generated + "\n// Operator edits\n");
    await rm(spec);
    await symlink(target, spec);
    const matrix = join(root, ".kit/monkey-test/role-matrix.json");
    await rm(matrix);
    await mkdir(matrix);

    const result = await writeMonkeyHarness(root, { force: true });
    assert.equal(result.ok, false);
    assert.equal(result.writes.filter(({ action }) => action === "skipped").length, 2);
    assert.equal((await lstat(spec)).isSymbolicLink(), true);
    assert.equal((await lstat(matrix)).isDirectory(), true);
    assert.equal(await readFile(target, "utf8"), generated + "\n// Operator edits\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const content of ["operator owned\n", ""]) {
  it(`does not force-reset ${content ? "unmanaged" : "empty"} scaffold files`, async () => {
    const root = await mkdtemp(join(tmpdir(), "kit-monkey-harness-unmanaged-"));
    try {
      assert.equal((await writeMonkeyHarness(root)).ok, true);
      const path = join(root, "tests/monkey/monkey.spec.ts");
      await writeFile(path, content);
      const result = await writeMonkeyHarness(root, { force: true });
      assert.ok((await readFile(path, "utf8")) === content, "operator bytes must survive force");
      assert.equal(result.ok, false);
      assert.equal(
        result.writes.find(({ path }) => path === "tests/monkey/monkey.spec.ts")?.action,
        "skipped",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

it("preserves edits to generated scaffold until force is requested", async () => {
  const root = await mkdtemp(join(tmpdir(), "kit-monkey-harness-edits-"));
  try {
    assert.equal((await writeMonkeyHarness(root)).ok, true);
    const path = join(root, "tests", "monkey", "monkey.spec.ts");
    const generated = await readFile(path, "utf8");
    const edited = generated + "\n// App-specific crawl assertion\n";
    await writeFile(path, edited);

    const result = await writeMonkeyHarness(root);
    assert.equal(await readFile(path, "utf8"), edited);
    assert.equal(result.ok, false);
    assert.equal(
      result.writes.find(({ path }) => path === "tests/monkey/monkey.spec.ts")?.action,
      "skipped",
    );
    assert.equal((await writeMonkeyHarness(root, { force: true })).ok, true);
    assert.equal(await readFile(path, "utf8"), generated);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("creates the complete harness and preserves operator-owned files", async () => {
  const root = await mkdtemp(join(tmpdir(), "kit-monkey-harness-"));
  try {
    const first = await writeMonkeyHarness(root);
    assert.equal(first.ok, true);
    assert.deepEqual(first.writes.map(({ path }) => path).sort(), [...MONKEY_HARNESS_FILES].sort());

    const operatorFile = join(root, "tests", "monkey", "README.md");
    await writeFile(operatorFile, "operator owned\n", "utf8");
    const second = await writeMonkeyHarness(root);
    assert.equal(second.ok, false);
    assert.equal(
      second.writes.find(({ path }) => path === "tests/monkey/README.md")?.action,
      "skipped",
    );
    assert.equal(await readFile(operatorFile, "utf8"), "operator owned\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
