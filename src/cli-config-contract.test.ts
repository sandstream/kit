import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import { createCliContractFixture } from "./cli-contract.test-support.js";

const original = '# Keep this explanation.\n[tools]\nnode = "22"\n';
let fixture: ReturnType<typeof createCliContractFixture>;
beforeEach(() => {
  fixture = createCliContractFixture(original);
});
afterEach(() => fixture.cleanup());

it("applies an explicit migration request, preserves comments and saves the original backup", () => {
  const result = fixture.run(["config", "migrate"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Migrated v0 -> v1/);
  const content = readFileSync(join(fixture.cwd, ".kit.toml"), "utf8");
  assert.match(content, /version = 1/);
  assert.ok(content.includes("# Keep this explanation.\n"));
  assert.ok(content.includes('[tools]\nnode = "22"\n'));
  assert.equal(readFileSync(join(fixture.cwd, ".kit.toml.backup"), "utf8"), original);
  const before = fixture.snapshot();
  const repeat = fixture.run(["config", "migrate"]);
  assert.equal(repeat.status, 0, repeat.stderr);
  assert.deepEqual(fixture.snapshot(), before);
});

for (const [flag, status] of [
  ["--dry-run", 0],
  ["--check", 1],
] as const) {
  it(`${flag} leaves a legacy config and its backup state unchanged`, () => {
    const before = fixture.snapshot();
    const result = fixture.run(["config", "migrate", flag]);
    assert.equal(result.status, status, result.stderr);
    assert.deepEqual(fixture.snapshot(), before);
  });
}

it("refuses to replace a previous backup and preserves the pending config", () => {
  writeFileSync(join(fixture.cwd, ".kit.toml.backup"), "Existing recovery copy.\n");
  const before = fixture.snapshot();
  const result = fixture.run(["config", "migrate"]);
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(fixture.snapshot(), before);
});

it("refuses invalid configuration without changing it", () => {
  writeFileSync(join(fixture.cwd, ".kit.toml"), '[tools\nnode = "22"\n');
  const before = fixture.snapshot();
  const result = fixture.run(["config", "migrate"]);
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(fixture.snapshot(), before);
});
