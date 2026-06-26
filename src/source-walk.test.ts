import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, isAbsolute, relative } from "node:path";
import { walkSourceFiles } from "./source-walk.js";

function tmpTree(): string {
  return mkdtempSync(join(tmpdir(), "kit-walk-"));
}

function touch(root: string, rel: string): void {
  const full = join(root, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, "// fixture\n");
}

function rels(root: string, files: string[]): string[] {
  return files.map((f) => relative(root, f).split(/[\\/]/).join("/")).sort();
}

describe("walkSourceFiles", () => {
  it("collects .ts files recursively and returns absolute paths", () => {
    const root = tmpTree();
    try {
      touch(root, "a.ts");
      touch(root, "nested/b.ts");
      touch(root, "nested/deep/c.ts");
      const files = walkSourceFiles(root);
      assert.ok(files.every((f) => isAbsolute(f)));
      assert.deepEqual(rels(root, files), ["a.ts", "nested/b.ts", "nested/deep/c.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("excludes *.test.ts by default", () => {
    const root = tmpTree();
    try {
      touch(root, "a.ts");
      touch(root, "a.test.ts");
      assert.deepEqual(rels(root, walkSourceFiles(root)), ["a.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("includes *.test.ts when includeTests is set", () => {
    const root = tmpTree();
    try {
      touch(root, "a.ts");
      touch(root, "a.test.ts");
      assert.deepEqual(rels(root, walkSourceFiles(root, { includeTests: true })), [
        "a.test.ts",
        "a.ts",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips default skipDirs (node_modules, dist, .next, .git, coverage)", () => {
    const root = tmpTree();
    try {
      touch(root, "src.ts");
      touch(root, "node_modules/pkg/index.ts");
      touch(root, "dist/out.ts");
      touch(root, ".next/build.ts");
      touch(root, ".git/hook.ts");
      touch(root, "coverage/report.ts");
      assert.deepEqual(rels(root, walkSourceFiles(root)), ["src.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips dotdirs and dotfiles", () => {
    const root = tmpTree();
    try {
      touch(root, "keep.ts");
      touch(root, ".hidden/secret.ts");
      touch(root, ".eslintrc.ts");
      assert.deepEqual(rels(root, walkSourceFiles(root)), ["keep.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("honours custom exts and only matches by extname", () => {
    const root = tmpTree();
    try {
      touch(root, "a.ts");
      touch(root, "b.tsx");
      touch(root, "c.js");
      const files = walkSourceFiles(root, { exts: [".ts", ".tsx"] });
      assert.deepEqual(rels(root, files), ["a.ts", "b.tsx"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("honours custom skipDirs (overriding defaults)", () => {
    const root = tmpTree();
    try {
      touch(root, "keep.ts");
      touch(root, "dist/out.ts");
      touch(root, "vendor/lib.ts");
      // Only skip 'vendor' -> dist is now walked.
      const files = walkSourceFiles(root, { skipDirs: ["vendor"] });
      assert.deepEqual(rels(root, files), ["dist/out.ts", "keep.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns [] for a non-existent root", () => {
    assert.deepEqual(walkSourceFiles(join(tmpdir(), "does-not-exist-kit-walk")), []);
  });
});
