/**
 * mise 2026.11 installs npm tools with a package manager that writes launcher scripts into
 * `node_modules/.bin` instead of links. `tsc` then resolves to a script with no link to follow, and
 * the standards gate reported "analysis is incomplete" on CI while every local run passed. These
 * tests hold both layouts, and the refusals that keep an unrelated package out.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { locateCompiler } from "./standards-javascript-compiler.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

function withRoot(run: (root: string) => void): void {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kit-javascript-compiler-")));
  try {
    run(root);
  } finally {
    rmTemp(root);
  }
}

function installPackage(dir: string, manifest: Record<string, unknown>): string {
  mkdirSync(join(dir, "bin"), { recursive: true });
  mkdirSync(join(dir, "lib"));
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
  writeFileSync(join(dir, "bin", "tsc"), "// compiler entry\n");
  writeFileSync(join(dir, "lib", "typescript.js"), "module.exports = {};\n");
  return dir;
}

function installLauncher(modules: string): string {
  mkdirSync(join(modules, ".bin"), { recursive: true });
  const launcher = join(modules, ".bin", "tsc");
  writeFileSync(launcher, "#!/bin/sh\n# launcher script, not a link\n", { mode: 0o755 });
  return launcher;
}

const SUPPORTED = { name: "typescript", version: "6.0.3" };

describe("locateCompiler: the package's own entry", () => {
  it("accepts bin/tsc inside a supported typescript package", () => {
    withRoot((root) => {
      const pkg = installPackage(join(root, "typescript"), SUPPORTED);
      assert.deepEqual(locateCompiler(join(pkg, "bin", "tsc")), {
        api: join(pkg, "lib", "typescript.js"),
        version: "6.0.3",
      });
    });
  });

  it("refuses a package with another name", () => {
    withRoot((root) => {
      const pkg = installPackage(join(root, "other"), { name: "other", version: "6.0.3" });
      assert.throws(() => locateCompiler(join(pkg, "bin", "tsc")), /supported canonical/);
    });
  });

  it("refuses a version outside the supported set", () => {
    withRoot((root) => {
      const pkg = installPackage(join(root, "typescript"), {
        name: "typescript",
        version: "4.0.0",
      });
      assert.throws(() => locateCompiler(join(pkg, "bin", "tsc")), /supported canonical/);
    });
  });
});

describe("locateCompiler: a launcher script in node_modules/.bin", () => {
  it("accepts the sibling typescript package", () => {
    withRoot((root) => {
      const modules = join(root, "node_modules");
      const pkg = installPackage(join(modules, "typescript"), SUPPORTED);
      assert.deepEqual(locateCompiler(installLauncher(modules)), {
        api: join(pkg, "lib", "typescript.js"),
        version: "6.0.3",
      });
    });
  });

  it(
    "follows the sibling package's link into the package store",
    // Creating a link needs a privilege on Windows that CI runners do not always hold.
    { skip: process.platform === "win32" ? "symlink creation is privileged on win32" : false },
    () => {
      withRoot((root) => {
        const modules = join(root, "node_modules");
        const store = installPackage(join(root, "store", "typescript"), SUPPORTED);
        mkdirSync(modules);
        symlinkSync(store, join(modules, "typescript"), "dir");
        assert.equal(
          locateCompiler(installLauncher(modules)).api,
          join(store, "lib", "typescript.js"),
        );
      });
    },
  );

  it("refuses when the sibling package is not a supported typescript", () => {
    withRoot((root) => {
      const modules = join(root, "node_modules");
      installPackage(join(modules, "typescript"), { name: "typescript", version: "4.0.0" });
      assert.throws(() => locateCompiler(installLauncher(modules)), /supported canonical/);
    });
  });

  it("refuses when no sibling typescript package exists", () => {
    withRoot((root) => {
      assert.throws(() => locateCompiler(installLauncher(join(root, "node_modules"))));
    });
  });
});
