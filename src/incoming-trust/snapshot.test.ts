import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { captureIncomingSnapshot } from "./snapshot.js";
import { snapshotFixture } from "./snapshot.test-support.js";

it("captures ignored and untracked bytes without executing project scripts", () => {
  const f = snapshotFixture();
  try {
    mkdirSync(join(f.source, "ignored"));
    const marker = join(f.root, "executed");
    writeFileSync(join(f.source, ".gitignore"), "ignored/\n");
    writeFileSync(join(f.source, "ignored", "payload.js"), "original bytes\n");
    writeFileSync(
      join(f.source, "package.json"),
      JSON.stringify({ scripts: { prepare: `touch ${marker}` } }),
    );
    const captured = captureIncomingSnapshot(f.source, f.destination);
    assert.match(captured.digest, /^[a-f0-9]{64}$/);
    assert.equal(captured.files, 3);
    assert.equal(
      readFileSync(join(captured.tree, "ignored", "payload.js"), "utf8"),
      "original bytes\n",
    );
    assert.equal(readFileSync(join(captured.tree, ".gitignore"), "utf8"), "ignored/\n");
    writeFileSync(join(f.source, "ignored", "payload.js"), "changed after capture\n");
    assert.equal(
      readFileSync(join(captured.tree, "ignored", "payload.js"), "utf8"),
      "original bytes\n",
    );
    assert.equal(existsSync(marker), false);
  } finally {
    f.cleanup();
  }
});

it("includes nested manifests and Git metadata as ordinary captured bytes", () => {
  const f = snapshotFixture();
  try {
    const files = [
      [".git/hooks/post-checkout", "exit 91\n"],
      [".git/config", "[core]\nrepositoryformatversion = 0\n"],
      ["packages/child/package.json", '{"name":"child"}\n'],
      ["packages/child/package-lock.json", '{"lockfileVersion":3}\n'],
    ];
    mkdirSync(join(f.source, ".git", "hooks"), { recursive: true });
    mkdirSync(join(f.source, "packages", "child"), { recursive: true });
    for (const [path, bytes] of files) writeFileSync(join(f.source, path), bytes);
    const captured = captureIncomingSnapshot(f.source, f.destination);
    assert.equal(captured.files, files.length);
    for (const [path, bytes] of files)
      assert.equal(readFileSync(join(captured.tree, path), "utf8"), bytes);
  } finally {
    f.cleanup();
  }
});
