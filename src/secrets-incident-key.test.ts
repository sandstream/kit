import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalProjectRoot,
  createIncidentKey,
  incidentKeyId,
  incidentKeyPath,
  isInsideTree,
  projectIdFromRoot,
  readIncidentKey,
  resolveIncidentProject,
} from "./secrets-incident-key.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const POSIX_ONLY =
  process.platform === "win32" &&
  "POSIX mode bits and unprivileged symlinks; Windows uses the ACL check in secure-perms";

function temp(prefix: string): string {
  return realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
}

function fixture() {
  const base = temp("kit-incident-key-");
  const repo = join(base, "repo");
  const keyRoot = join(base, "home", ".kit", "incident-keys");
  mkdirSync(join(repo, "sub"), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repo });
  return { base, repo, keyRoot };
}

describe("incident key project id", () => {
  it("folds case and separators where the filesystem usually does", () => {
    assert.equal(canonicalProjectRoot("C:\\Work\\Repo", "win32"), "c:/work/repo");
    assert.equal(canonicalProjectRoot("/Users/A/Repo", "darwin"), "/users/a/repo");
    assert.equal(canonicalProjectRoot("/home/A/Repo", "linux"), "/home/A/Repo");
    assert.equal(
      projectIdFromRoot("C:\\Work\\Repo", "win32"),
      projectIdFromRoot("c:/work/repo", "win32"),
    );
    assert.notEqual(
      projectIdFromRoot("/home/A/Repo", "linux"),
      projectIdFromRoot("/home/a/repo", "linux"),
    );
    assert.match(projectIdFromRoot("/x", "linux"), /^[0-9a-f]{32}$/);
  });

  it("is the same from the repo root and a subdirectory, and fails when cwd is gone", async () => {
    const f = fixture();
    try {
      const a = await resolveIncidentProject(f.repo);
      const b = await resolveIncidentProject(join(f.repo, "sub"));
      assert.equal(a.id, b.id);
      assert.equal(a.root, realpathSync.native(f.repo));
      await assert.rejects(
        resolveIncidentProject(join(f.base, "missing")),
        /cannot determine the project id/,
      );
    } finally {
      rmTemp(f.base);
    }
  });
});

describe("incident key file", () => {
  it("round-trips owner-only outside the repo, and only replaces a key when asked", async () => {
    const f = fixture();
    try {
      const project = await resolveIncidentProject(f.repo);
      const key = await createIncidentKey(f.keyRoot, project, "env", false);
      const path = incidentKeyPath(f.keyRoot, project.id, "env");
      assert.equal(isInsideTree(path, project.root), false);
      if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.deepEqual(await readIncidentKey(f.keyRoot, project, "env"), key);
      await assert.rejects(createIncidentKey(f.keyRoot, project, "env", false), /already exists/);
      const next = await createIncidentKey(f.keyRoot, project, "env", true);
      assert.notEqual(incidentKeyId(next), incidentKeyId(key));
    } finally {
      rmTemp(f.base);
    }
  });

  it("refuses a missing or malformed key and never creates one on read", async () => {
    const f = fixture();
    try {
      const project = await resolveIncidentProject(f.repo);
      await assert.rejects(readIncidentKey(f.keyRoot, project, "env"), /incident key missing/);
      await createIncidentKey(f.keyRoot, project, "env", false);
      const path = incidentKeyPath(f.keyRoot, project.id, "env");
      writeFileSync(path, "not-hex\n");
      await assert.rejects(readIncidentKey(f.keyRoot, project, "env"), /malformed/);
    } finally {
      rmTemp(f.base);
    }
  });

  it("refuses a key root inside the project, however it is spelled", async () => {
    const f = fixture();
    try {
      const project = await resolveIncidentProject(f.repo);
      const inside = join(f.repo, ".kit", "incident-keys");
      await assert.rejects(createIncidentKey(inside, project, "env", false), /inside the project/);
      await assert.rejects(readIncidentKey(inside, project, "env"), /inside the project/);
      assert.equal(isInsideTree(join(f.repo, "sub", "x.key"), f.repo), true);
      assert.equal(isInsideTree(join(f.base, "repo2", "x.key"), f.repo), false);
    } finally {
      rmTemp(f.base);
    }
  });

  it("refuses a widened, symlinked or hard-linked key", { skip: POSIX_ONLY }, async () => {
    const f = fixture();
    try {
      const project = await resolveIncidentProject(f.repo);
      await createIncidentKey(f.keyRoot, project, "env", false);
      const path = incidentKeyPath(f.keyRoot, project.id, "env");
      chmodSync(path, 0o644);
      await assert.rejects(readIncidentKey(f.keyRoot, project, "env"), /not owner-only/);
      chmodSync(path, 0o600);
      const real = join(f.base, "elsewhere.key");
      renameSync(path, real);
      symlinkSync(real, path);
      await assert.rejects(readIncidentKey(f.keyRoot, project, "env"), /symlink/);
      await assert.rejects(createIncidentKey(f.keyRoot, project, "env", true), /not a regular/);
      assert.equal(readFileSync(real, "utf8").trim().length, 64, "the link target is untouched");
      // A symlinked key root that resolves into the repo is inside it.
      const linkedRoot = join(f.base, "linked-root");
      symlinkSync(join(f.repo, "sub"), linkedRoot);
      await assert.rejects(readIncidentKey(linkedRoot, project, "env"), /inside the project/);
      assert.equal(isInsideTree(join(linkedRoot, "x.key"), f.repo), true);
    } finally {
      rmTemp(f.base);
    }
  });
});
