import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { auditPull, reportSeverity } from "./post-pull-audit.js";

function git(dir: string, ...args: string[]): void {
  execFileSync("git", args, { cwd: dir });
}

function tmpRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-audit-pull-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  return dir;
}

function commit(dir: string, msg: string): void {
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", msg);
}

describe("auditPull", () => {
  it("returns empty report when nothing changed", async () => {
    const dir = tmpRepo();
    try {
      writeFileSync(join(dir, "README.md"), "# repo\n");
      commit(dir, "initial");
      writeFileSync(join(dir, "README.md"), "# repo (updated)\n");
      commit(dir, "edit readme");
      const r = await auditPull(dir);
      assert.equal(r.newDependencies.length, 0);
      assert.equal(r.plaintextHits.length, 0);
      assert.equal(reportSeverity(r), "ok");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects new dependencies in package.json", async () => {
    const dir = tmpRepo();
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "t", dependencies: { next: "^15.0.0" } }, null, 2),
      );
      commit(dir, "initial");
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify(
          {
            name: "t",
            dependencies: { next: "^15.0.0", "left-pad": "1.3.0" },
          },
          null,
          2,
        ),
      );
      commit(dir, "add dep");
      const r = await auditPull(dir);
      assert.deepEqual(r.newDependencies, ["left-pad"]);
      assert.equal(reportSeverity(r), "warn");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("flags removed .gitignore entries as sensitive when env/key-related", async () => {
    const dir = tmpRepo();
    try {
      writeFileSync(join(dir, ".gitignore"), ".env\nnode_modules\n*.pem\n");
      commit(dir, "initial");
      writeFileSync(join(dir, ".gitignore"), "node_modules\n");
      commit(dir, "loosen ignore");
      const r = await auditPull(dir);
      assert.ok(r.removedGitignoreEntries.includes(".env"));
      assert.ok(r.removedGitignoreEntries.includes("*.pem"));
      assert.equal(reportSeverity(r), "fail");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("flags introduced plaintext secrets", async () => {
    const dir = tmpRepo();
    try {
      writeFileSync(join(dir, "README.md"), "# repo\n");
      commit(dir, "initial");
      writeFileSync(
        join(dir, "config.ts"),
        'export const KEY = "' + "sk_" + "test_51T2AMtJLRlXeUG4dKBwX2nsve3BLEzy" + '";\n',
      );
      commit(dir, "add config");
      const r = await auditPull(dir);
      assert.equal(r.plaintextHits.length, 1);
      assert.equal(r.plaintextHits[0].file, "config.ts");
      assert.equal(reportSeverity(r), "fail");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("flags kit security-config file changes", async () => {
    const dir = tmpRepo();
    try {
      writeFileSync(
        join(dir, ".kit-allowlist.json"),
        JSON.stringify(
          {
            policy: { enforce_runtime: true, enforce_dev: false, allow_wildcards: false },
            packages: [],
          },
          null,
          2,
        ),
      );
      commit(dir, "initial");
      writeFileSync(
        join(dir, ".kit-allowlist.json"),
        JSON.stringify(
          {
            policy: { enforce_runtime: false, enforce_dev: false, allow_wildcards: true },
            packages: [],
          },
          null,
          2,
        ),
      );
      commit(dir, "relax allowlist");
      const r = await auditPull(dir);
      assert.equal(r.allowlistChanged, true);
      assert.equal(reportSeverity(r), "warn");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
