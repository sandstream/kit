import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasMarker } from "./scan-detect.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

describe("hasMarker", () => {
  const root = mkdtempSync(join(tmpdir(), "kit-marker-"));
  mkdirSync(join(root, "infra", "dev"), { recursive: true });
  mkdirSync(join(root, "node_modules", "x"), { recursive: true });
  mkdirSync(join(root, ".terraform", "modules"), { recursive: true });
  writeFileSync(join(root, "infra", "dev", "main.tf"), "");
  writeFileSync(join(root, "node_modules", "x", "vendored.tf"), "");
  writeFileSync(join(root, ".terraform", "modules", "downloaded.tf"), "");
  writeFileSync(join(root, "Dockerfile"), "");

  it("finds an exact name at the root", () => {
    assert.equal(hasMarker(root, ["Dockerfile"]), true);
    assert.equal(hasMarker(root, ["missing.txt"]), false);
  });

  it("finds an extension pattern in a subdirectory", () => {
    assert.equal(hasMarker(root, ["*.tf"]), true);
  });

  it("does not count vendored or downloaded copies", () => {
    const only = mkdtempSync(join(tmpdir(), "kit-marker-"));
    try {
      mkdirSync(join(only, "node_modules", "x"), { recursive: true });
      mkdirSync(join(only, ".terraform", "modules"), { recursive: true });
      writeFileSync(join(only, "node_modules", "x", "v.tf"), "");
      writeFileSync(join(only, ".terraform", "modules", "d.tf"), "");
      assert.equal(hasMarker(only, ["*.tf"]), false);
    } finally {
      rmTemp(only);
    }
  });

  it("stops looking below three levels", () => {
    const deep = mkdtempSync(join(tmpdir(), "kit-marker-"));
    try {
      mkdirSync(join(deep, "a", "b", "c", "d"), { recursive: true });
      writeFileSync(join(deep, "a", "b", "c", "d", "x.tf"), "");
      assert.equal(hasMarker(deep, ["*.tf"]), false);
    } finally {
      rmTemp(deep);
    }
  });

  it("cleanup", () => rmTemp(root));
});

import { trackedProviderFiles, providersTracked } from "./scan-detect.js";

describe("trackedProviderFiles", () => {
  it("is true when git tracks a file under a terraform providers directory", () => {
    assert.equal(trackedProviderFiles("src/a.ts\0.terraform/providers/x/lock.json\0"), true);
    assert.equal(trackedProviderFiles("infra/dev/.terraform/providers/y/bin\0"), true);
  });

  it("is true for a path with characters that git would quote without -z", () => {
    assert.equal(trackedProviderFiles("infra/\u00f6 dir/.terraform/providers/y/bin\0"), true);
    assert.equal(trackedProviderFiles("a\nb/.terraform/providers/y/bin\0"), true);
  });

  it("is false for ordinary tracked files, including the lock file", () => {
    assert.equal(trackedProviderFiles(".terraform.lock.hcl\0infra/main.tf\0"), false);
    assert.equal(trackedProviderFiles(""), false);
  });

  it("does not match a lookalike directory name", () => {
    assert.equal(trackedProviderFiles("my.terraform/providers/x\0terraform/providers/x\0"), false);
  });
});

describe("providersTracked", () => {
  const ok = (stdout: string) => ({ ok: true, stdout });
  const bad = { ok: false, stdout: "" };

  it("is false outside a git repository, where nothing can be tracked", () => {
    assert.equal(providersTracked(bad, bad), false);
  });

  it("fails closed when git is inside a repository but ls-files fails", () => {
    assert.equal(providersTracked(ok("true\n"), bad), true);
  });

  it("reads the listing when git works", () => {
    assert.equal(providersTracked(ok("true\n"), ok("a\0")), false);
    assert.equal(providersTracked(ok("true\n"), ok(".terraform/providers/x\0")), true);
  });
});
