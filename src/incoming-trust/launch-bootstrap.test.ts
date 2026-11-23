import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { readLaunchScripts, RUN_ENV } from "./launch-profile.js";
import { snapshotFixture } from "./snapshot.test-support.js";

it("does not load a program when the external profile is removed", () => {
  const f = snapshotFixture();
  try {
    const entry = join(f.source, "main.mjs");
    const authority = join(f.root, "authority.sqlite");
    const marker = join(f.root, "entered");
    writeFileSync(authority, "synthetic authority");
    writeFileSync(
      entry,
      'import fs from "node:fs"; fs.writeFileSync(' + JSON.stringify(marker) + ', "entered");',
    );
    const scripts = readLaunchScripts();
    const deadline = String(Date.now() + 5000);
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        scripts.bootstrap,
        "--",
        JSON.stringify({
          entry,
          authority,
          output: f.root,
          runId: "nonce",
          approvalDeadline: Number(deadline),
        }),
      ],
      {
        cwd: f.root,
        env: RUN_ENV,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe", "pipe"],
        timeout: 5000,
      },
    );
    assert.equal(child.status, 125, child.stderr);
    assert.equal(child.output[3], "");
    assert.equal(existsSync(marker), false);
  } finally {
    f.cleanup();
  }
});
