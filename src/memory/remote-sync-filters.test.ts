import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { insertMessage, searchMessages, upsertSession } from "./db.js";
import { gitHistoryFixture } from "./remote-sync-causal.test-support.js";

for (const file of ["memory.enc", "!memory[1].enc"]) {
  it(`preserves ${file} when Git attributes select a content-changing clean filter`, async (t) => {
    const files = gitHistoryFixture(t);
    files.config.file = file;
    const seed = join(files.dir, "remote-seed");
    mkdirSync(seed);
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: seed, encoding: "utf8", stdio: "pipe" });
    git("init", "-q", "-b", "main");
    writeFileSync(join(seed, ".gitattributes"), "*.enc filter=fixture\n");
    git("add", ".gitattributes");
    git("commit", "-qm", "fixture attributes");
    git("push", "-q", files.config.remote!, "main");
    git(
      "config",
      "--file",
      process.env.GIT_CONFIG_GLOBAL!,
      "filter.fixture.clean",
      "printf damaged",
    );

    await files.memory((db) => {
      upsertSession(db, { sessionId: "filter-source", harness: "claude-code" });
      insertMessage(db, {
        uuid: "filter-message",
        sessionId: "filter-source",
        type: "assistant",
        content: "ciphertextmarker must reach the next machine",
      });
    });
    files.push();
    files.device("b");
    assert.equal(files.pull().messages, 1);
    assert.equal(await files.memory((db) => searchMessages(db, "ciphertextmarker").length), 1);
  });
}

it("reads the committed ciphertext without a checkout smudge filter changing it", async (t) => {
  const files = gitHistoryFixture(t);
  await files.memory((db) => {
    upsertSession(db, { sessionId: "smudge-source", harness: "codex" });
    insertMessage(db, {
      uuid: "smudge-message",
      sessionId: "smudge-source",
      type: "assistant",
      content: "smudgemarker",
    });
  });
  files.push();
  const seed = join(files.dir, "smudge-seed");
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: files.dir, encoding: "utf8", stdio: "pipe" });
  git("clone", "-q", "--branch", "main", files.config.remote!, seed);
  writeFileSync(join(seed, ".gitattributes"), "memory.enc filter=fixture\n");
  git("-C", seed, "add", ".gitattributes");
  git("-C", seed, "commit", "-qm", "fixture checkout attributes");
  git("-C", seed, "push", "-q", "origin", "main");
  git("config", "--file", process.env.GIT_CONFIG_GLOBAL!, "filter.fixture.smudge", "exit 17");
  git("config", "--file", process.env.GIT_CONFIG_GLOBAL!, "filter.fixture.required", "true");
  files.device("b");
  assert.equal(files.pull().messages, 1);
  assert.equal(await files.memory((db) => searchMessages(db, "smudgemarker").length), 1);
  files.device("a");
  files.push(false);
  await files.memory((db) =>
    insertMessage(db, {
      uuid: "smudge-update",
      sessionId: "smudge-source",
      type: "assistant",
      content: "smudgemarker updated",
    }),
  );
  files.push();
  files.device("c");
  assert.equal(files.pull().messages, 2);
});

it("uses the configured snapshot name literally and preserves other remote files", async (t) => {
  const files = gitHistoryFixture(t);
  files.config.file = "snapshot[1].enc";
  const seed = join(files.dir, "name-seed");
  mkdirSync(seed);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: seed, encoding: "utf8", stdio: "pipe" });
  git("init", "-q", "-b", "main");
  writeFileSync(join(seed, "keep.txt"), "keep this remote file\n");
  git("add", "keep.txt");
  git("commit", "-qm", "fixture existing content");
  git("push", "-q", files.config.remote!, "main");
  await files.memory((db) => {
    upsertSession(db, { sessionId: "literal-source", harness: "codex" });
    insertMessage(db, {
      uuid: "literal-message",
      sessionId: "literal-source",
      type: "assistant",
      content: "literalmarker",
    });
  });
  files.push();
  files.device("b");
  assert.equal(files.pull().messages, 1);
  git("fetch", "-q", files.config.remote!, "main");
  assert.equal(git("show", "FETCH_HEAD:keep.txt"), "keep this remote file\n");
});

it("keeps checkout filters active for a nested file with the same snapshot name", async (t) => {
  const files = gitHistoryFixture(t);
  const seed = join(files.dir, "nested-seed");
  mkdirSync(join(seed, "nested"), { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: seed, encoding: "utf8", stdio: "pipe" });
  git("init", "-q", "-b", "main");
  writeFileSync(join(seed, ".gitattributes"), "*.enc filter=fixture\n");
  writeFileSync(join(seed, "nested", "memory.enc"), "stored bytes\n");
  git("add", ".");
  git("commit", "-qm", "fixture nested file");
  git("push", "-q", files.config.remote!, "main");
  const hooks = join(files.dir, "nested-hooks");
  mkdirSync(hooks);
  const hook = join(hooks, "pre-commit");
  writeFileSync(
    hook,
    '#!/bin/sh\ntest "$(cat nested/memory.enc)" = transformed || { echo missing-nested-filter >&2; exit 38; }\n',
  );
  chmodSync(hook, 0o700);
  git("config", "--file", process.env.GIT_CONFIG_GLOBAL!, "core.hooksPath", hooks);
  git(
    "config",
    "--file",
    process.env.GIT_CONFIG_GLOBAL!,
    "filter.fixture.smudge",
    "printf transformed",
  );
  await files.memory((db) => {
    upsertSession(db, { sessionId: "nested-source", harness: "codex" });
    insertMessage(db, {
      uuid: "nested-message",
      sessionId: "nested-source",
      type: "assistant",
      content: "nested file filter stays active",
    });
  });
  files.push();
  files.device("b");
  assert.equal(files.pull().messages, 1);
});

it(
  "protects a snapshot filename containing a control character from checkout filters",
  {
    skip:
      process.platform === "win32" && "Windows filenames do not support ASCII control characters",
  },
  async (t) => {
    const files = gitHistoryFixture(t);
    files.config.file = "memory\u000b.enc";
    await files.memory((db) => {
      upsertSession(db, { sessionId: "control-source", harness: "codex" });
      insertMessage(db, {
        uuid: "control-message",
        sessionId: "control-source",
        type: "assistant",
        content: "control character filename marker",
      });
    });
    files.push();
    const seed = join(files.dir, "control-seed");
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: files.dir, encoding: "utf8", stdio: "pipe" });
    git("clone", "-q", "--branch", "main", files.config.remote!, seed);
    writeFileSync(join(seed, ".gitattributes"), "*.enc filter=fixture\n");
    git("-C", seed, "add", ".gitattributes");
    git("-C", seed, "commit", "-qm", "fixture control filename attributes");
    git("-C", seed, "push", "-q", "origin", "main");
    git("config", "--file", process.env.GIT_CONFIG_GLOBAL!, "filter.fixture.smudge", "exit 17");
    git("config", "--file", process.env.GIT_CONFIG_GLOBAL!, "filter.fixture.required", "true");
    files.push(false);
    files.device("b");
    assert.equal(files.pull().messages, 1);
  },
);

it("refuses publication when a commit hook replaces the staged ciphertext", async (t) => {
  const files = gitHistoryFixture(t);
  await files.memory((db) => {
    upsertSession(db, { sessionId: "hook-source", harness: "codex" });
    insertMessage(db, {
      uuid: "hook-message",
      sessionId: "hook-source",
      type: "assistant",
      content: "hookmarker stays local",
    });
  });
  const hooks = join(files.dir, "hooks");
  mkdirSync(hooks);
  const hook = join(hooks, "pre-commit");
  writeFileSync(
    hook,
    '#!/bin/sh\nobject=$(printf corrupted | git hash-object -w --stdin)\ngit update-index --cacheinfo 100644,"$object",memory.enc\n',
  );
  chmodSync(hook, 0o700);
  execFileSync("git", [
    "config",
    "--file",
    process.env.GIT_CONFIG_GLOBAL!,
    "core.hooksPath",
    hooks,
  ]);
  assert.throws(() => files.push(), /snapshot.*changed|ciphertext.*changed/i);
  const remote = execFileSync("git", ["ls-remote", "--heads", files.config.remote!], {
    encoding: "utf8",
  });
  assert.equal(remote.trim(), "");
  assert.equal(await files.memory((db) => searchMessages(db, "hookmarker").length), 1);
});

it("still runs a configured commit hook stored in the remote checkout", async (t) => {
  const files = gitHistoryFixture(t);
  const seed = join(files.dir, "hook-seed");
  mkdirSync(join(seed, ".githooks"), { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: seed, encoding: "utf8", stdio: "pipe" });
  git("init", "-q", "-b", "main");
  const hook = join(seed, ".githooks", "pre-commit");
  writeFileSync(hook, "#!/bin/sh\necho fixture-hook-refuses >&2\nexit 37\n");
  chmodSync(hook, 0o700);
  git("add", ".githooks/pre-commit");
  git("update-index", "--chmod=+x", ".githooks/pre-commit");
  git("commit", "-qm", "fixture tracked hook");
  git("push", "-q", files.config.remote!, "main");
  const before = git("ls-remote", "--heads", files.config.remote!);
  git("config", "--file", process.env.GIT_CONFIG_GLOBAL!, "core.hooksPath", ".githooks");
  await files.memory((db) => {
    upsertSession(db, { sessionId: "tracked-hook", harness: "claude-code" });
    insertMessage(db, {
      uuid: "tracked-hook-message",
      sessionId: "tracked-hook",
      type: "assistant",
      content: "local memory with tracked hooks",
    });
  });
  assert.throws(() => files.push(), /fixture-hook-refuses/);
  assert.equal(git("ls-remote", "--heads", files.config.remote!), before);
});

it(
  "keeps attributes shared through a Git template symlink unchanged",
  {
    skip: process.platform === "win32" && "Requires POSIX Git template symlinks",
  },
  async (t) => {
    const files = gitHistoryFixture(t);
    await files.memory((db) => {
      upsertSession(db, { sessionId: "template-source", harness: "codex" });
      insertMessage(db, {
        uuid: "template-message",
        sessionId: "template-source",
        type: "assistant",
        content: "template marker",
      });
    });
    files.push();
    const shared = join(files.dir, "shared-attributes");
    const original = "# owned outside the temporary clone\n";
    writeFileSync(shared, original);
    const info = join(process.env.GIT_TEMPLATE_DIR!, "info");
    mkdirSync(info);
    symlinkSync(shared, join(info, "attributes"));
    files.push(false);
    assert.equal(readFileSync(shared, "utf8"), original);
  },
);
