import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  findInstallScripts,
  findLockDrift,
  findNonRegistryResolved,
  findDepConfusion,
  editDistance,
  findSlopsquat,
  parseLockPkgs,
  type LockPkg,
} from "./supply-chain.js";

const lockPkgs: LockPkg[] = [
  {
    path: "node_modules/lodash",
    name: "lodash",
    version: "4.17.21",
    resolved: "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz",
  },
  {
    path: "node_modules/esbuild",
    name: "esbuild",
    version: "0.20.0",
    resolved: "https://registry.npmjs.org/esbuild/-/esbuild-0.20.0.tgz",
    hasInstallScript: true,
  },
  {
    path: "node_modules/sketchy",
    name: "sketchy",
    version: "1.0.0",
    resolved: "https://evil.example/sketchy.tgz",
  },
  {
    path: "node_modules/@acme/core",
    name: "@acme/core",
    version: "2.0.0",
    resolved: "https://registry.npmjs.org/@acme/core/-/core-2.0.0.tgz",
  },
];

describe("findInstallScripts", () => {
  it("flags only packages with hasInstallScript", () => {
    assert.deepEqual(findInstallScripts(lockPkgs), ["esbuild@0.20.0"]);
  });
});

describe("findLockDrift", () => {
  it("flags declared deps absent from the lockfile", () => {
    const lockNames = new Set(lockPkgs.map((p) => p.name));
    assert.deepEqual(findLockDrift(["lodash", "ghost-dep"], lockNames), ["ghost-dep"]);
  });
});

describe("findNonRegistryResolved", () => {
  it("flags http/git tarball sources, not registry ones", () => {
    const bad = findNonRegistryResolved(lockPkgs);
    assert.equal(bad.length, 1);
    assert.equal(bad[0].name, "sketchy");
  });
});

describe("findDepConfusion", () => {
  const resolved = new Map(lockPkgs.map((p) => [p.name, p.resolved] as const));
  it("flags an internal-scoped dep resolved from the public registry", () => {
    assert.deepEqual(findDepConfusion(["@acme/core"], resolved, ["@acme"]), ["@acme/core"]);
  });
  it("is empty when no internal scopes are declared", () => {
    assert.deepEqual(findDepConfusion(["@acme/core"], resolved, []), []);
  });
  it("does not flag a scope substring match (@acme vs @acme-tools)", () => {
    const r = new Map([["@acme-tools/x", "https://registry.npmjs.org/x"] as const]);
    assert.deepEqual(findDepConfusion(["@acme-tools/x"], r, ["@acme"]), []);
  });
});

describe("editDistance (bounded Damerau)", () => {
  it("treats a transposition as a single edit, plus subs/inserts/deletes, and caps", () => {
    assert.equal(editDistance("lodash", "lodash"), 0);
    assert.equal(editDistance("lodash", "lodahs"), 1); // adjacent transposition
    assert.equal(editDistance("react", "preact"), 1); // insertion
    assert.equal(editDistance("abc", "xyzzy", 2), 3); // exceeds cap
  });
});

describe("findSlopsquat", () => {
  it("flags a 1-edit look-alike of a popular package", () => {
    const hits = findSlopsquat(["lodahs", "expres"]); // lodash, express look-alikes
    const names = hits.map((h) => h.name);
    assert.ok(names.includes("lodahs"));
    assert.ok(names.includes("expres"));
  });
  it("does not flag exact popular packages or distant names", () => {
    assert.deepEqual(findSlopsquat(["lodash", "my-unique-internal-pkg"]), []);
  });
});

describe("parseLockPkgs", () => {
  it("skips the root entry and flattens packages", () => {
    const pkgs = parseLockPkgs({
      packages: { "": { name: "root" }, "node_modules/x": { version: "1.0.0", resolved: "r" } },
    });
    assert.equal(pkgs.length, 1);
    assert.equal(pkgs[0].name, "x");
  });
});
