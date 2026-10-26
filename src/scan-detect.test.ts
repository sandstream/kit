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
