import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { setTimeout as pause } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { startImageOwner, type ImageOwnerRequest } from "./sealed-image-owner.js";
import { snapshotFixture } from "./snapshot.test-support.js";

function ownerHost(root: string, preloadPath: string): string {
  const host = join(root, "owner-node");
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  writeFileSync(
    host,
    `#!/bin/sh\nexec ${quote(process.execPath)} --import ${quote(preloadPath)} "$@"\n`,
    { mode: 0o700 },
  );
  return host;
}

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

it(
  "does not add files after the image owner starts removing its workspace",
  {
    skip: process.platform === "win32",
    timeout: 10_000,
  },
  async () => {
    const f = snapshotFixture();
    try {
      const root = realpathSync(f.root);
      const workspace = join(root, "kit-incoming-sealed-test");
      mkdirSync(workspace, { mode: 0o700 });
      const cleaning = join(root, "cleaning");
      const preload = join(root, "cleanup-fixture.mjs");
      writeFileSync(
        preload,
        `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
const workspace = ${JSON.stringify(workspace)};
const remove = fs.rmSync;
fs.rmSync = (path, options) => {
  if (path !== workspace) return remove(path, options);
  // Freeze the directory listing before the parent reacts to the failed mount.
  const entries = fs.readdirSync(path);
  const marker = join(path, "image-release");
  fs.writeFileSync(${JSON.stringify(cleaning)}, "");
  const deadline = Date.now() + 1000;
  const wait = new Int32Array(new SharedArrayBuffer(4));
  while (!fs.existsSync(marker) && Date.now() < deadline) Atomics.wait(wait, 0, 0, 10);
  for (const entry of entries) remove(join(path, entry), options);
  fs.rmdirSync(path);
};
syncBuiltinESMExports();
`,
      );
      const host = ownerHost(root, preload);
      const owner = startImageOwner(workspace, lstatSync(workspace, { bigint: true }), host);
      owner.awaitReady();
      assert.throws(
        () => owner.mount({ source: f.source, executable: false }),
        /Disk image owner refused mount/,
      );
      const limit = AbortSignal.timeout(5000);
      while (!existsSync(cleaning)) await pause(10, undefined, { signal: limit });
      owner.release();
      assert.equal(existsSync(workspace), false);
    } finally {
      f.cleanup();
    }
  },
);

for (const [step, fixtureSource] of [
  ["detach-image", 'replace(cp, "execFileSync", (command) => command === "/usr/bin/hdiutil");'],
  ["inspect-mount", 'replace(fs, "lstatSync", (path) => path === workspace + "/mounted");'],
  ["remove-workspace", 'replace(fs, "rmSync", (path) => path === workspace);'],
  [
    "retry-mount",
    `const inspect = fs.lstatSync;
let mounted = true;
fs.lstatSync = (path, ...args) => {
  if (path !== workspace + "/mounted" || !mounted) return inspect(path, ...args);
  mounted = false;
  return { dev: -1n };
};`,
  ],
]) {
  const retry = step === "retry-mount";
  it(
    retry
      ? "retries cleanup while the mount is still present"
      : `reports ${step} without forwarding the internal error`,
    {
      skip: process.platform === "win32",
      timeout: 10_000,
    },
    () => {
      const f = snapshotFixture();
      try {
        const root = realpathSync(f.root);
        const workspace = join(root, "kit-incoming-sealed-test");
        mkdirSync(workspace, { mode: 0o700 });
        if (step === "detach-image") writeFileSync(join(workspace, "candidate.dmg"), "fixture");
        const preload = join(root, "refuse-cleanup.mjs");
        writeFileSync(
          preload,
          `
import fs from "node:fs";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const workspace = ${JSON.stringify(workspace)};
function replace(module, method, matches) {
  const original = module[method];
  module[method] = (target, ...args) => {
    if (matches(target)) throw new Error("private fixture path and diagnostic");
    return original(target, ...args);
  };
}
${fixtureSource}
syncBuiltinESMExports();
`,
        );
        const owner = startImageOwner(
          workspace,
          lstatSync(workspace, { bigint: true }),
          ownerHost(root, preload),
        );
        owner.awaitReady();
        if (retry) {
          owner.release();
          assert.equal(existsSync(workspace), false);
          return;
        }
        assert.throws(() => owner.release(), {
          message: `Disk image cleanup failed (${step})`,
          cleanupStep: step,
        });
        assert.ok(existsSync(workspace));
      } finally {
        f.cleanup();
      }
    },
  );
}
