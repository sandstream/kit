import assert from "node:assert/strict";
import {
  closeSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { inventoryFixture } from "./standards-javascript-inventory.test-support.js";

const symlinks = {
  skip:
    process.platform === "win32"
      ? "File symlinks require Windows developer mode or privilege"
      : false,
};

test(
  "refuses a Git-listed directory symlink instead of silently omitting its sources",
  symlinks,
  (t) => {
    const fixture = inventoryFixture(t);
    writeFileSync(join(fixture.project, "main.ts"), "function main() { return 1; }");
    const control = fixture.scan();
    assert.equal(control.didNotRun, false, control.issue);
    assert.deepEqual(control.files, ["main.ts"]);
    const outside = join(fixture.root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "hidden.ts"), "function hidden(x) { if (x) return 1; return 0; }");
    symlinkSync(outside, join(fixture.project, "linked-sources"), "dir");
    fixture.git("add", "linked-sources", "main.ts");
    assert.ok(fixture.git("ls-files", "-z").split("\0").includes("linked-sources"));
    const result = fixture.scan();
    assert.equal(result.didNotRun, true, JSON.stringify(result));
    assert.deepEqual(result.findings, []);
  },
);

test("ignores a deleted tracked source but refuses a broken source symlink", symlinks, (t) => {
  const fixture = inventoryFixture(t);
  writeFileSync(join(fixture.project, "main.ts"), "function main() { return 1; }");
  writeFileSync(join(fixture.project, "deleted.ts"), "function deleted() { return 2; }");
  fixture.git("add", ".");
  rmSync(join(fixture.project, "deleted.ts"));
  const control = fixture.scan();
  assert.equal(control.didNotRun, false, control.issue);
  assert.deepEqual(control.files, ["main.ts"]);
  symlinkSync("missing.ts", join(fixture.project, "broken.ts"));
  fixture.git("add", "broken.ts");
  const result = fixture.scan();
  assert.equal(result.didNotRun, true, JSON.stringify(result));
  assert.deepEqual(result.findings, []);
});

test("refuses a real Git configuration failure even when its path contains ENOENT", (t) => {
  const fixture = inventoryFixture(t);
  writeFileSync(join(fixture.project, "main.ts"), "function main() { return 1; }");
  fixture.git("config", "include.path", "../ENOENT");
  writeFileSync(join(fixture.project, "ENOENT"), "[broken config");
  const result = fixture.scan();
  assert.equal(result.didNotRun, true, JSON.stringify(result));
  assert.deepEqual(result.findings, []);
});

test("refuses an oversized source before reading its contents into memory", (t) => {
  const fixture = inventoryFixture(t);
  const control = fixture.scanMeasured();
  assert.equal(control.result.didNotRun, false, control.result.issue);
  const fd = openSync(join(fixture.project, "oversized.ts"), "w");
  try {
    ftruncateSync(fd, 128 * 1024 * 1024);
  } finally {
    closeSync(fd);
  }
  const measured = fixture.scanMeasured();
  assert.equal(measured.result.didNotRun, true);
  assert.deepEqual(measured.result.findings, []);
  const increase = measured.maxRSS - control.maxRSS;
  t.diagnostic(`Peak RSS: baseline ${control.maxRSS} KiB, oversized source ${measured.maxRSS} KiB`);
  assert.ok(increase < 64 * 1024, `Reading a rejected source added ${increase} KiB to peak RSS`);
});

test("refuses invalid UTF-8 in the real Git inventory instead of dropping the source entry", (t) => {
  const fixture = inventoryFixture(t);
  const blob = fixture.gitInput("const x = 1;", "hash-object", "-w", "--stdin").trim();
  fixture.gitInput(
    Buffer.concat([Buffer.from(`100644 ${blob}\t`), Buffer.from([0xff]), Buffer.from(".ts\0")]),
    "update-index",
    "-z",
    "--index-info",
  );
  const result = fixture.scan();
  assert.equal(result.didNotRun, true, JSON.stringify(result));
  assert.deepEqual(result.findings, []);
});

test("honors Git ignore rules without omitting tracked or untracked source files", (t) => {
  const fixture = inventoryFixture(t);
  writeFileSync(join(fixture.project, ".gitignore"), "ignored.ts\nignored-dir/\ntracked.ts\n");
  for (const file of ["tracked.ts", "new.ts"]) {
    writeFileSync(join(fixture.project, file), "function measured() { return 1; }");
  }
  fixture.git("add", "-f", "tracked.ts");
  writeFileSync(join(fixture.project, "ignored.ts"), "function invalid(");
  for (const directory of ["ignored-dir", "node_modules"]) {
    mkdirSync(join(fixture.project, directory));
    writeFileSync(join(fixture.project, directory, "invalid.ts"), "function invalid(");
  }
  const result = fixture.scan();
  assert.equal(result.didNotRun, false, result.issue);
  assert.deepEqual(result.files, ["new.ts", "tracked.ts"]);
  assert.deepEqual(
    result.findings.filter((finding) => finding.fn === "measured").map((finding) => finding.file),
    ["new.ts", "tracked.ts"],
  );
});

test(
  "scans an internal source symlink but refuses a source file outside the project",
  symlinks,
  (t) => {
    const fixture = inventoryFixture(t);
    writeFileSync(join(fixture.project, "source.ts"), "function measured() { return 1; }");
    symlinkSync("source.ts", join(fixture.project, "alias.ts"));
    const control = fixture.scan();
    assert.equal(control.didNotRun, false, control.issue);
    assert.deepEqual(control.files, ["alias.ts", "source.ts"]);
    const outside = join(fixture.root, "outside.ts");
    writeFileSync(outside, "function outside() { return 1; }");
    symlinkSync(outside, join(fixture.project, "escape.ts"));
    const result = fixture.scan();
    assert.equal(result.didNotRun, true);
    assert.deepEqual(result.findings, []);
  },
);

test("keeps valid UTF-8 across read boundaries and refuses malformed source bytes", (t) => {
  const fixture = inventoryFixture(t);
  const name = "\ufeffunicode.ts";
  const path = join(fixture.project, name);
  const prefix = `//${" ".repeat(65_533)}`;
  const suffix = "\nfunction measured() { return 1; }";
  writeFileSync(path, `${prefix}é${suffix}`);
  const control = fixture.scan();
  assert.equal(control.didNotRun, false, control.issue);
  assert.deepEqual(control.files, [name]);
  assert.equal(control.findings.find((finding) => finding.fn === "measured")?.ccn, 1);
  writeFileSync(
    path,
    Buffer.concat([Buffer.from(prefix), Buffer.from([0xc3]), Buffer.from(suffix)]),
  );
  const result = fixture.scan();
  assert.equal(result.didNotRun, true);
  assert.deepEqual(result.findings, []);
});

test("inventories nested sources without a Git repository and without a Git executable", (t) => {
  const fixture = inventoryFixture(t);
  rmSync(join(fixture.project, ".git"), { recursive: true });
  mkdirSync(join(fixture.project, "nested"));
  writeFileSync(join(fixture.project, "nested", "source.ts"), "function measured() { return 1; }");
  const unversioned = fixture.scan();
  assert.equal(unversioned.didNotRun, false, unversioned.issue);
  assert.deepEqual(unversioned.files, [join("nested", "source.ts")]);
  fixture.env.PATH = fixture.bin;
  const unavailable = fixture.scan();
  assert.equal(unavailable.didNotRun, false, unavailable.issue);
  assert.deepEqual(unavailable.files, [join("nested", "source.ts")]);
});

test("preserves a source BOM in the public function identity", (t) => {
  const fixture = inventoryFixture(t);
  writeFileSync(join(fixture.project, "bom.ts"), "\ufefffunction measured() { return 1; }");
  const result = fixture.scan();
  assert.equal(result.didNotRun, false, result.issue);
  assert.deepEqual(result.files, ["bom.ts"]);
  const body = result.findings.find((finding) => finding.fn === "measured");
  assert.ok(body, JSON.stringify(result));
  assert.equal(body.identity, "function:1");
});

for (const boundary of ["untracked nested repository", "tracked gitlink"]) {
  test(`refuses an unresolved ${boundary} after measuring ordinary nested sources`, (t) => {
    const fixture = inventoryFixture(t);
    const nested = join(fixture.project, "nested");
    mkdirSync(nested);
    writeFileSync(join(fixture.project, "visible.ts"), "function visible() { return 1; }");
    writeFileSync(join(nested, "hidden.ts"), "function hidden(x) { if (x) return 1; return 0; }");
    fixture.git("add", "visible.ts");
    const control = fixture.scan();
    assert.equal(control.didNotRun, false, control.issue);
    assert.deepEqual(control.files, ["nested/hidden.ts", "visible.ts"]);
    assert.equal(control.findings.find((finding) => finding.fn === "hidden")?.ccn, 2);

    fixture.git("init", "--quiet", nested);
    if (boundary === "tracked gitlink") {
      fixture.git("-C", nested, "add", "hidden.ts");
      const tree = fixture.git("-C", nested, "write-tree").trim();
      const commit = fixture
        .git(
          "-C",
          nested,
          "-c",
          "user.name=Inventory Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "-c",
          "commit.gpgsign=false",
          "commit-tree",
          tree,
          "-m",
          "Fixture",
        )
        .trim();
      fixture.git("update-index", "--add", "--cacheinfo", `160000,${commit},nested`);
    }
    const listed = fixture
      .git("ls-files", "-co", "--exclude-standard", "-z")
      .split("\0")
      .filter(Boolean)
      .sort();
    assert.deepEqual(listed, [boundary === "tracked gitlink" ? "nested" : "nested/", "visible.ts"]);
    t.diagnostic(`Git inventory: ${JSON.stringify(listed)}`);
    const result = fixture.scan();
    assert.equal(result.didNotRun, true, JSON.stringify(result));
    assert.deepEqual(result.findings, []);
  });
}
