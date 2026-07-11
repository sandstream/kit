import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parsePythonImports, resolvePythonImport } from "./extract-py.js";

describe("repomap extract-py — parsePythonImports", () => {
  it("captures import / from-import forms, aliases, commas, relative dots", () => {
    const src = `
      import os
      import a.b.c as abc
      import x, y as why
      from pkg.mod import thing
      from . import sibling
      from .local import f
      from ..up import g
      from pkg import (one, two)
      # import commented.out
    `;
    assert.deepEqual(parsePythonImports(src), [
      "os",
      "a.b.c",
      "x",
      "y",
      "pkg.mod",
      ".sibling",
      ".local",
      "..up",
      "pkg",
    ]);
  });

  it("ignores commented lines and dedupes", () => {
    assert.deepEqual(parsePythonImports("import os\nimport os\n# import re"), ["os"]);
  });
});

describe("repomap extract-py — resolvePythonImport", () => {
  const fileSet = new Set([
    "pkg/__init__.py",
    "pkg/mod.py",
    "pkg/sub/__init__.py",
    "pkg/sub/deep.py",
    "app/main.py",
    "app/util.py",
    "src/lib/thing.py",
  ]);

  it("resolves a relative sibling import (from .local import x)", () => {
    assert.equal(resolvePythonImport("app/main.py", ".util", fileSet), "app/util.py");
  });

  it("resolves `from . import sub` to the submodule/package", () => {
    assert.equal(resolvePythonImport("pkg/mod.py", ".sub", fileSet), "pkg/sub/__init__.py");
  });

  it("resolves a parent-relative import (..up style) up the tree", () => {
    // from pkg/sub/deep.py, `..mod` → pkg/mod.py
    assert.equal(resolvePythonImport("pkg/sub/deep.py", "..mod", fileSet), "pkg/mod.py");
  });

  it("resolves an absolute dotted import from the repo root", () => {
    assert.equal(resolvePythonImport("app/main.py", "pkg.mod", fileSet), "pkg/mod.py");
    assert.equal(resolvePythonImport("app/main.py", "pkg.sub.deep", fileSet), "pkg/sub/deep.py");
  });

  it("resolves an absolute import by a UNIQUE path suffix (src/ layout)", () => {
    assert.equal(resolvePythonImport("app/main.py", "lib.thing", fileSet), "src/lib/thing.py");
  });

  it("returns null for an unresolved (external / stdlib) import — never guessed", () => {
    assert.equal(resolvePythonImport("app/main.py", "os", fileSet), null);
    assert.equal(resolvePythonImport("app/main.py", "numpy.linalg", fileSet), null);
  });

  it("returns null when a parent-relative import walks above the repo root", () => {
    assert.equal(resolvePythonImport("main.py", "..x", fileSet), null);
  });
});
