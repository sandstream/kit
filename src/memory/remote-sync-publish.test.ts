import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { insertMessage, searchMessages, upsertSession } from "./db.js";
import { pullMemory, pushMemory } from "./remote-sync.js";
import { gitHistoryFixture } from "./remote-sync-causal.test-support.js";
import { racePublisher } from "./remote-sync-publish.test-support.js";

const passphrase = "Concurrent-History-Copper-9573";

it("concurrent first publishers retry without losing either accepted snapshot", async (t) => {
  const files = gitHistoryFixture(t);
  for (const name of ["a", "b"] as const) {
    files.device(name);
    await files.memory((db) => {
      upsertSession(db, { sessionId: name, harness: name === "a" ? "claude-code" : "codex" });
      insertMessage(db, {
        uuid: name,
        sessionId: name,
        type: "assistant",
        content: `racemarker ${name}`,
      });
    });
  }
  const publishers = await Promise.all([
    racePublisher(t, files.dir, files.config, passphrase, "a"),
    racePublisher(t, files.dir, files.config, passphrase, "b"),
  ]);
  for (const result of publishers) {
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).verified, true);
  }
  files.device("c");
  assert.equal(pullMemory(files.config, passphrase, files.dir).found, true);
  assert.deepEqual(
    await files.memory((db) =>
      searchMessages(db, "racemarker")
        .map((hit) => hit.uuid)
        .sort(),
    ),
    ["a", "b"],
  );
});

it("Git push exit zero is not a verified receipt when the remote immediately loses the commit", async (t) => {
  const files = gitHistoryFixture(t);
  await files.memory((db) => {
    upsertSession(db, { sessionId: "unacknowledged", harness: "codex" });
    insertMessage(db, {
      uuid: "unacknowledged",
      sessionId: "unacknowledged",
      type: "assistant",
      content: "must remain local",
    });
  });
  const hook = join(files.dir, "memory.git", "hooks", "post-receive");
  mkdirSync(join(files.dir, "memory.git", "hooks"), { recursive: true });
  writeFileSync(hook, "#!/bin/sh\ngit update-ref -d refs/heads/main\n");
  chmodSync(hook, 0o700);
  let failure: unknown;
  try {
    pushMemory(files.config, passphrase, files.dir);
  } catch (error) {
    failure = error;
  }
  const advertised = execFileSync("git", ["ls-remote", "--heads", files.config.remote!], {
    encoding: "utf8",
  });
  assert.equal(advertised.trim(), "", "the server really removed the accepted branch");
  assert.ok(failure instanceof Error, "publication needs a readable remote acknowledgment");
  assert.equal(await files.memory((db) => searchMessages(db, "local").length), 1);
});
