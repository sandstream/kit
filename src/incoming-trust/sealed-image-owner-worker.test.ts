import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import type { ImageOwnerRequest } from "./sealed-image-owner.js";
import { snapshotFixture } from "./snapshot.test-support.js";

it("does not remove a workspace without its exact claim", () => {
  const f = snapshotFixture();
  try {
    const workspace = join(realpathSync(f.root), "kit-incoming-sealed-test");
    mkdirSync(workspace, { mode: 0o700 });
    const { dev, ino } = lstatSync(workspace, { bigint: true });
    writeFileSync(join(workspace, "image-claim"), "0".repeat(64));
    const request: ImageOwnerRequest = {
      workspace,
      claim: "1".repeat(64),
      device: dev.toString(),
      inode: ino.toString(),
      parent: process.pid,
    };
    const worker = fileURLToPath(new URL("./sealed-image-owner-worker.js", import.meta.url));
    const run = spawnSync(process.execPath, [worker, JSON.stringify(request)], {
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(run.status, 1, String(run.error) + run.stderr);
    assert.match(run.stderr, /no workspace claim/);
    assert.ok(existsSync(workspace));
  } finally {
    f.cleanup();
  }
});
