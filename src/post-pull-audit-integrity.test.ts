import { it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditPull, reportSeverity } from "./post-pull-audit.js";
import { rmTemp } from "./temp-cleanup.test-support.js";
import { git, repo, write, commit, cli } from "./post-pull-audit.test-support.js";

it("fails closed for invalid base and head refs without replacing the requested range", async (t) => {
  const dir = repo(t);
  commit(dir);
  for (const [base, head] of [
    ["missing-base", "HEAD"],
    ["HEAD~1", "missing-head"],
  ]) {
    const report = await auditPull(dir, base, head);
    assert.equal(reportSeverity(report), "fail");
    assert.equal(report.baseRef, base);
    assert.equal(report.headRef, head);
    assert.equal(report.coverage.status, "incomplete");
    assert.equal(report.errors[0].code, "ref-unavailable");
  }
});

it("reports an unreadable changed Git blob as unknown, never absent or clean", async (t) => {
  const dir = repo(t);
  write(dir, "config.txt", "incoming content\n");
  commit(dir);
  const oid = git(dir, "rev-parse", "HEAD:config.txt");
  unlinkSync(join(dir, ".git", "objects", oid.slice(0, 2), oid.slice(2)));
  const report = await auditPull(dir);
  assert.equal(reportSeverity(report), "fail");
  assert.equal(report.coverage.status, "incomplete");
  assert.deepEqual(report.changedFiles, ["config.txt"]);
  assert.ok(report.errors.some((e) => e.code === "git-read-failed" && e.file === "config.txt"));
});

it("fails closed for invalid manifest JSON and dependency shapes on either side", async (t) => {
  const dir = repo(t);
  for (const content of [
    "{",
    "null",
    "[]",
    '{"dependencies":[]}',
    '{"dependencies":null}',
    '{"devDependencies":{"example":42}}',
  ]) {
    write(dir, "package.json", content);
    commit(dir);
    const invalidHead = await auditPull(dir);
    assert.equal(reportSeverity(invalidHead), "fail", content);
    assert.ok(
      invalidHead.errors.some((e) => e.code === "invalid-manifest" && e.file === "package.json"),
    );
    write(dir, "package.json", '{"dependencies":{"example":"1.0.0"}}');
    commit(dir);
    const invalidBase = await auditPull(dir);
    assert.equal(reportSeverity(invalidBase), "fail", content);
    assert.deepEqual(invalidBase.newDependencies, []);
    assert.deepEqual(invalidBase.removedDependencies, []);
  }
});

it("reports version, source and package-name changes in root and nested manifests", async (t) => {
  const dir = repo(t);
  const file = "packages/nested space/package.json";
  write(
    dir,
    file,
    JSON.stringify({
      dependencies: { source: "1.0.0", oldName: "2.0.0" },
      optionalDependencies: { optional: "1.0.0" },
      peerDependencies: { peer: "^1" },
    }),
  );
  commit(dir);
  write(dir, "package.json", '{"dependencies":{"example":"2.0.0"}}');
  write(
    dir,
    file,
    JSON.stringify({
      dependencies: { source: "git+https://example.invalid/repo.git#abc", newName: "2.0.0" },
      optionalDependencies: { optional: "npm:replacement@1.0.0" },
      peerDependencies: { peer: "^2" },
    }),
  );
  commit(dir);
  const report = await auditPull(dir);
  assert.equal(reportSeverity(report), "warn");
  assert.equal(report.coverage.status, "complete");
  assert.deepEqual(report.newDependencies, ["newName"]);
  assert.deepEqual(report.removedDependencies, ["oldName"]);
  assert.deepEqual(report.dependencyChanges, [
    {
      file: "package.json",
      section: "dependencies",
      name: "example",
      kind: "changed",
      before: "1.0.0",
      after: "2.0.0",
    },
    {
      file,
      section: "dependencies",
      name: "newName",
      kind: "added",
      before: null,
      after: "2.0.0",
    },
    {
      file,
      section: "dependencies",
      name: "oldName",
      kind: "removed",
      before: "2.0.0",
      after: null,
    },
    {
      file,
      section: "dependencies",
      name: "source",
      kind: "changed",
      before: "1.0.0",
      after: "git+https://example.invalid/repo.git#abc",
    },
    {
      file,
      section: "optionalDependencies",
      name: "optional",
      kind: "changed",
      before: "1.0.0",
      after: "npm:replacement@1.0.0",
    },
    {
      file,
      section: "peerDependencies",
      name: "peer",
      kind: "changed",
      before: "^1",
      after: "^2",
    },
  ]);
});

it("retains deletion scope without scanning removed files as introduced content", async (t) => {
  const dir = repo(t);
  write(dir, "nested/package.json", '{"dependencies":{"nested":"1.0.0"}}');
  write(dir, ".gitignore", ".env\n");
  write(dir, ".kit-policy.json", "{}");
  write(dir, "AGENTS.md", "Local instructions\n");
  write(dir, "config.txt", "ghp_" + "a".repeat(36));
  commit(dir);
  const removed = [
    ".gitignore",
    ".kit-policy.json",
    "AGENTS.md",
    "config.txt",
    "nested/package.json",
    "package.json",
  ];
  for (const file of removed) unlinkSync(join(dir, file));
  commit(dir);
  const report = await auditPull(dir);
  assert.deepEqual(report.removedFiles, removed);
  assert.deepEqual(report.changedFiles, []);
  assert.deepEqual(report.removedDependencies, ["example", "nested"]);
  assert.deepEqual(report.newDependencies, []);
  assert.deepEqual(report.plaintextHits, []);
  assert.deepEqual(report.agentFiles, []);
  assert.deepEqual(report.removedGitignoreEntries, [".env"]);
  assert.equal(report.policyChanged, true);
  assert.equal(report.coverage.status, "complete");
  assert.equal(reportSeverity(report), "fail");
});

it("masks credentials in API diagnostics and dependency specifications", async (t) => {
  const dir = repo(t);
  const token = "ghp_" + "b".repeat(36);
  const password = "fixture-password-value";
  write(
    dir,
    "package.json",
    JSON.stringify({
      dependencies: { example: `https://user:${password}@example.invalid/package.tgz` },
    }),
  );
  write(dir, "nested/package.json", `{"broken":"${token}`);
  commit(dir);
  const report = await auditPull(dir);
  const output = JSON.stringify(report);
  assert.ok(!output.includes(token));
  assert.ok(!output.includes(password));
  assert.equal(report.coverage.status, "incomplete");
  assert.ok(report.errors.some((e) => e.code === "invalid-manifest"));
  assert.match(report.dependencyChanges[0].after ?? "", /\[REDACTED\]/);
  const invalidRef = JSON.stringify(await auditPull(dir, token));
  assert.ok(!invalidRef.includes(token));
});

it("refuses a manifest symlink even when its target text is valid JSON", async (t) => {
  const dir = repo(t);
  const oid = execFileSync("git", ["hash-object", "-w", "--stdin"], {
    cwd: dir,
    encoding: "utf8",
    input: "{}",
  }).trim();
  git(dir, "update-index", "--add", "--cacheinfo", `120000,${oid},nested/package.json`);
  git(dir, "commit", "-qm", "fixture symlink");
  const report = await auditPull(dir);
  assert.equal(reportSeverity(report), "fail");
  assert.ok(
    report.errors.some((e) => e.code === "unsupported-entry" && e.file === "nested/package.json"),
  );
});

it("distinguishes an unknown file scope from a successfully inspected empty range", async (t) => {
  const dir = repo(t);
  write(dir, "README.md", "hello\n");
  commit(dir);
  const tree = git(dir, "rev-parse", "HEAD^{tree}");
  unlinkSync(join(dir, ".git", "objects", tree.slice(0, 2), tree.slice(2)));
  const report = await auditPull(dir);
  assert.equal(reportSeverity(report), "fail");
  assert.equal(report.coverage.fileScope, "unknown");
  assert.ok(report.errors.some((e) => e.operation === "list-tree"));
  const text = cli(dir, "--base", "HEAD~1");
  assert.equal(text.status, 1);
  assert.match(text.output, /File scope is unknown/);
  assert.doesNotMatch(text.output, /0 added\/modified/);
});

it("keeps unchanged specifications clean and inspects commits rather than dirty or untracked files", async (t) => {
  const dir = repo(t);
  write(dir, "nested/package.json", '{"devDependencies":{"tool":"1.0.0"}}');
  commit(dir);
  write(dir, "package.json", '{"description":"metadata only","dependencies":{"example":"1.0.0"}}');
  write(dir, "README.md", "ordinary change\n");
  commit(dir);
  write(dir, "package.json", "invalid working copy");
  write(dir, "untracked/package.json", "invalid untracked manifest");
  for (const base of ["HEAD~1", "HEAD"]) {
    const report = await auditPull(dir, base);
    assert.equal(reportSeverity(report), "ok");
    assert.equal(report.coverage.status, "complete");
    assert.equal(report.coverage.fileScope, "known");
    assert.deepEqual(report.coverage.manifestFiles, ["nested/package.json", "package.json"]);
    assert.deepEqual(report.dependencyChanges, []);
    assert.deepEqual(report.errors, []);
    const result = cli(dir, "--base", base, "--json");
    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.output).severity, "ok");
  }
});

it("retains additions and removals of entire nested manifests", async (t) => {
  const dir = repo(t);
  write(dir, "new/package.json", '{"dependencies":{"added":"1.0.0"}}');
  commit(dir);
  const added = await auditPull(dir);
  assert.equal(reportSeverity(added), "warn");
  assert.deepEqual(added.newDependencies, ["added"]);
  unlinkSync(join(dir, "new/package.json"));
  commit(dir);
  const removed = await auditPull(dir);
  assert.equal(reportSeverity(removed), "ok");
  assert.equal(removed.coverage.status, "complete");
  assert.deepEqual(removed.newDependencies, []);
  assert.deepEqual(removed.removedDependencies, ["added"]);
  assert.deepEqual(removed.removedFiles, ["new/package.json"]);
  assert.deepEqual(removed.dependencyChanges, [
    {
      file: "new/package.json",
      section: "dependencies",
      name: "added",
      kind: "removed",
      before: "1.0.0",
      after: null,
    },
  ]);
});

it("warns when a dependency moves between sections without changing its name or version", async (t) => {
  const dir = repo(t);
  write(dir, "package.json", '{"devDependencies":{"example":"1.0.0"}}');
  commit(dir);
  const report = await auditPull(dir);
  assert.equal(reportSeverity(report), "warn");
  assert.deepEqual(report.newDependencies, []);
  assert.deepEqual(report.removedDependencies, []);
  assert.deepEqual(
    report.dependencyChanges.map((change) => [change.section, change.kind]),
    [
      ["dependencies", "removed"],
      ["devDependencies", "added"],
    ],
  );
});

it("rejects malformed nested manifests even when the selected range has no changed files", async (t) => {
  const dir = repo(t);
  write(dir, "nested/package.json", '{"peerDependencies":[]}');
  commit(dir);
  const report = await auditPull(dir, "HEAD", "HEAD");
  assert.equal(reportSeverity(report), "fail");
  assert.equal(report.coverage.fileScope, "known");
  assert.deepEqual(report.changedFiles, []);
  assert.deepEqual(
    report.errors.map((error) => [error.code, error.file]),
    [
      ["invalid-manifest", "nested/package.json"],
      ["invalid-manifest", "nested/package.json"],
    ],
  );
});

it("fails closed for unavailable history, absent repositories and option-shaped refs", async (t) => {
  const dir = repo(t);
  const noRepo = mkdtempSync(join(tmpdir(), "kit-pull-no-repo-"));
  t.after(() => rmTemp(noRepo));
  for (const [cwd, base] of [
    [dir, "HEAD~1"],
    [noRepo, "HEAD"],
    [join(dir, "absent"), "HEAD"],
    [dir, "--all"],
  ]) {
    const report = await auditPull(cwd, base);
    assert.equal(reportSeverity(report), "fail");
    assert.equal(report.coverage.fileScope, "unknown");
    assert.ok(report.errors.some((error) => error.code === "ref-unavailable"));
  }
});

it("does not invent dependency or ignore removals when either version cannot be read", async (t) => {
  for (const file of ["package.json", ".gitignore"]) {
    for (const ref of ["HEAD~1", "HEAD"]) {
      const dir = repo(t);
      write(dir, ".gitignore", ".env\n");
      commit(dir);
      write(dir, ".gitignore", "node_modules\n");
      write(dir, "package.json", '{"dependencies":{"added":"1.0.0"}}');
      commit(dir);
      const oid = git(dir, "rev-parse", `${ref}:${file}`);
      unlinkSync(join(dir, ".git", "objects", oid.slice(0, 2), oid.slice(2)));
      const report = await auditPull(dir);
      assert.equal(reportSeverity(report), "fail");
      assert.equal(report.coverage.fileScope, "known");
      assert.ok(
        report.errors.some((error) => error.code === "git-read-failed" && error.file === file),
      );
      if (file === "package.json") {
        assert.deepEqual(report.dependencyChanges, []);
        assert.deepEqual(report.newDependencies, []);
        assert.deepEqual(report.removedDependencies, []);
      } else {
        assert.deepEqual(report.removedGitignoreEntries, []);
        assert.deepEqual(report.newGitignoreEntries, []);
      }
    }
  }
});

it("reports blobs above the read limit as incomplete instead of silently skipping them", async (t) => {
  const dir = repo(t);
  write(dir, "large.txt", "x".repeat(5 * 1024 * 1024 + 4096));
  commit(dir);
  const report = await auditPull(dir);
  assert.equal(reportSeverity(report), "fail");
  assert.equal(report.coverage.status, "incomplete");
  assert.ok(
    report.errors.some((error) => error.code === "git-read-failed" && error.file === "large.txt"),
  );
  const json = cli(dir, "--base", "HEAD~1", "--json");
  assert.equal(json.status, 1);
  assert.equal(JSON.parse(json.output).coverage.status, "incomplete");
});

it("declares lockfile dependency inspection outside coverage", async (t) => {
  const dir = repo(t);
  write(dir, "package-lock.json", '{"lockfileVersion":3,"packages":{}}');
  commit(dir);
  const report = await auditPull(dir);
  assert.equal(report.coverage.lockfileDependencies, "not-inspected");
  assert.deepEqual(report.dependencyChanges, []);
  const text = cli(dir, "--base", "HEAD~1");
  assert.equal(text.status, 0);
  assert.match(text.output, /Not covered: lockfile dependency resolution/);
  assert.match(text.output, /No findings within the reported inspection scope/);
});
