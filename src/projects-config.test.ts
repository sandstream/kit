import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectsSchema, resolveProjectPaths } from "./projects-config.js";
import { loadConfig, InvalidConfigError } from "./config.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

function repo(dirs: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "kit-projects-"));
  for (const d of dirs) mkdirSync(join(root, d), { recursive: true });
  return root;
}

describe("resolveProjectPaths", () => {
  it("accepts existing directories and returns them normalised", () => {
    const root = repo(["backend", "infra/ipf"]);
    try {
      const r = resolveProjectPaths(root, ["backend", "./infra/ipf/"]);
      assert.deepEqual(r.projects, ["backend", "infra/ipf"]);
      assert.deepEqual(r.refused, []);
    } finally {
      rmTemp(root);
    }
  });

  it("removes duplicates and keeps declaration order", () => {
    const root = repo(["a", "b"]);
    try {
      assert.deepEqual(resolveProjectPaths(root, ["b", "a", "./b"]).projects, ["b", "a"]);
    } finally {
      rmTemp(root);
    }
  });

  it("refuses a missing directory and names it", () => {
    const root = repo(["a"]);
    try {
      const r = resolveProjectPaths(root, ["a", "missing"]);
      assert.deepEqual(r.projects, ["a"]);
      assert.equal(r.refused[0].path, "missing");
      assert.match(r.refused[0].reason, /does not exist/);
    } finally {
      rmTemp(root);
    }
  });

  it("refuses a file, an absolute path, .. and the root itself", () => {
    const root = repo(["a"]);
    writeFileSync(join(root, "file.txt"), "");
    try {
      const r = resolveProjectPaths(root, ["file.txt", "/etc", "../x", "a/../../y", "."]);
      assert.deepEqual(r.projects, []);
      assert.equal(r.refused.length, 5);
    } finally {
      rmTemp(root);
    }
  });

  it("refuses a directory that is a symlink out of the repository", () => {
    const root = repo(["a"]);
    const outside = repo(["x"]);
    try {
      symlinkSync(outside, join(root, "link"));
      const r = resolveProjectPaths(root, ["link", "a"]);
      assert.deepEqual(r.projects, ["a"]);
      assert.match(r.refused[0].reason, /outside the repository/);
    } finally {
      rmTemp(root);
      rmTemp(outside);
    }
  });

  it("an undeclared list is empty and refuses nothing", () => {
    const root = repo([]);
    try {
      assert.deepEqual(resolveProjectPaths(root, undefined), { projects: [], refused: [] });
    } finally {
      rmTemp(root);
    }
  });
});

describe("[projects] in .kit.toml", () => {
  it("the schema takes a list of strings and nothing else", () => {
    assert.ok(ProjectsSchema.safeParse({ paths: ["a", "b/c"] }).success);
    assert.ok(!ProjectsSchema.safeParse({ paths: "a" }).success);
    assert.ok(!ProjectsSchema.safeParse({ paths: [1] }).success);
  });

  it("a path that leaves the repository is a config error, not a silent skip", async () => {
    const root = repo([]);
    try {
      for (const bad of ["../x", "/etc", "a/../../x"]) {
        writeFileSync(join(root, ".kit.toml"), `[projects]\npaths = ["${bad}"]\n`);
        await assert.rejects(loadConfig(join(root, ".kit.toml")), InvalidConfigError);
      }
    } finally {
      rmTemp(root);
    }
  });

  it("loads a valid list", async () => {
    const root = repo([]);
    try {
      writeFileSync(join(root, ".kit.toml"), '[projects]\npaths = ["backend", "infra/x"]\n');
      const cfg = await loadConfig(join(root, ".kit.toml"));
      assert.deepEqual(cfg.projects?.paths, ["backend", "infra/x"]);
    } finally {
      rmTemp(root);
    }
  });
});
