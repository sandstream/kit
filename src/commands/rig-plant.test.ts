import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { historyRepo } from "../rig/plant.test-support.js";
import { rmTemp } from "../temp-cleanup.test-support.js";

const adjacentCli = resolve(import.meta.dirname, "../cli.js");
const CLI = existsSync(adjacentCli)
  ? adjacentCli
  : resolve(import.meta.dirname, "../../dist/cli.js");

function kit(dir: string, args: string[], extraEnv: Record<string, string> = {}) {
  return spawnSync(process.execPath, [CLI, "rig", ...args], {
    cwd: dir,
    env: {
      ...process.env,
      HOME: dir,
      USERPROFILE: dir,
      KIT_IDENTITY_DIR: join(dir, ".id"),
      KIT_MEMORY_DIR: join(dir, ".mem"),
      KIT_AUDIT_ANCHOR_DIR: join(dir, ".anchor"),
      NODE_NO_WARNINGS: "1",
      ...extraEnv,
    },
    encoding: "utf8",
  });
}

describe("kit rig plant", () => {
  it("plants a reverted fix, writes its patch and prints a block the rest of the rig accepts", () => {
    const { dir, fix, pinned } = historyRepo();
    try {
      writeFileSync(
        join(dir, "rig.toml"),
        `[input]\nrepo = "acme/webapp"\ncommit = "${pinned}"\nprompt = "prompt.md"\n\n[[control]]\nid = "c1"\npatch = "c1.diff"\n`,
      );
      writeFileSync(join(dir, "prompt.md"), "Review.\n");
      writeFileSync(join(dir, "c1.diff"), "");
      const run = kit(dir, [
        "plant",
        "--from-fix",
        fix,
        "--split",
        "holdout",
        "--id",
        "auth-verify",
        "--json",
      ]);
      assert.equal(run.status, 0, run.stderr);
      const out = JSON.parse(run.stdout) as { file: string; patch: string; toml: string };
      assert.equal(out.file, "auth.ts");
      assert.equal(out.patch, "defects/auth-verify.diff");
      assert.match(
        readFileSync(join(dir, "defects", "auth-verify.diff"), "utf8"),
        /^\+if \(token\) allow\(\);$/m,
      );

      writeFileSync(
        join(dir, "rig.toml"),
        readFileSync(join(dir, "rig.toml"), "utf8") + "\n" + out.toml,
      );
      assert.equal(kit(dir, ["plan"]).status, 0);
      const again = kit(dir, [
        "plant",
        "--from-fix",
        fix,
        "--split",
        "tune",
        "--id",
        "auth-verify",
      ]);
      assert.notEqual(again.status, 0);
      assert.match(again.stderr, /already exists/);
    } finally {
      rmTemp(dir);
    }
  });

  it("refuses without a split, without a pinned commit, and when the reverse does not apply", () => {
    const { dir, fix, twoFile } = historyRepo();
    try {
      assert.match(kit(dir, ["plant", "--from-fix", fix]).stderr, /--split must be/);
      assert.match(
        kit(dir, ["plant", "--from-fix", fix, "--split", "tune"]).stderr,
        /no pinned commit/,
      );
      const bad = kit(dir, ["plant", "--from-fix", fix, "--split", "tune", "--pinned", twoFile]);
      assert.notEqual(bad.status, 0);
      assert.match(bad.stderr, /does not apply cleanly/);
      assert.equal(existsSync(join(dir, "defects")), false);
    } finally {
      rmTemp(dir);
    }
  });

  it("is refused in read-only mode", () => {
    const { dir, fix, pinned } = historyRepo();
    try {
      const ro = kit(dir, ["plant", "--from-fix", fix, "--split", "tune", "--pinned", pinned], {
        KIT_READ_ONLY: "1",
      });
      assert.notEqual(ro.status, 0);
      assert.equal(existsSync(join(dir, "defects")), false);
    } finally {
      rmTemp(dir);
    }
  });
});
