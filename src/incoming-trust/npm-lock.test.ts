import { it } from "node:test";
import assert from "node:assert/strict";
import { inspectNpmLock } from "./npm-lock.js";
import { bytes, fixture, input, integrity } from "./npm-lock.test-support.js";

it("inventories a complete small v3 fixture without a verification or approval verdict", () => {
  const result = inspectNpmLock(input());
  assert.equal(result.schema, "kit.incoming-trust.npm-lock");
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.lockfileVersion, 3);
  assert.equal(result.lockfileName, "package-lock.json");
  assert.deepEqual(result.completeness, {
    status: "complete",
    scope: "supplied-npm-input-inventory",
  });
  assert.equal(result.verification, "not-performed");
  assert.deepEqual(result.issues, []);
  assert.deepEqual(
    result.packages.map((p) => [p.path, p.name, p.version]),
    [
      ["", "fixture", "1.0.0"],
      ["node_modules/alpha", "alpha", "1.0.0"],
    ],
  );
  assert.deepEqual(result.artifacts, [
    {
      packagePath: "node_modules/alpha",
      name: "alpha",
      version: "1.0.0",
      source: "registry-tarball",
      resolved: "https://registry.npmjs.org/alpha/-/alpha-1.0.0.tgz",
      integrity,
    },
  ]);
  assert.deepEqual(result.edges, [
    { from: "", section: "dependencies", name: "alpha", spec: "^1.0.0", optional: false },
  ]);
  assert.deepEqual(result.scripts, []);
  assert.deepEqual(result.links, []);
  assert.deepEqual(result.workspaces, { patterns: [], packages: [] });
  assert.ok(!("safe" in result) && !("pass" in result));
});

it("retains transitive-only artifact changes and a nested install-script indicator", () => {
  const f = fixture();
  f.lock.packages["node_modules/alpha"].dependencies = { beta: "1.0.0" };
  f.lock.packages["node_modules/alpha/node_modules/beta"] = {
    name: "beta",
    version: "1.0.0",
    resolved: "https://cdn.example.test/beta.tgz",
    integrity,
    hasInstallScript: true,
    optional: true,
  };
  const before = inspectNpmLock(input(f));
  f.lock.packages["node_modules/alpha/node_modules/beta"].integrity =
    `sha512-${Buffer.alloc(64, 2).toString("base64")}`;
  const after = inspectNpmLock(input(f));
  assert.equal(before.completeness.status, "complete");
  assert.equal(before.packages.length, 3);
  assert.equal(before.artifacts[1].source, "remote-tarball");
  assert.equal(before.packages[2].hasInstallScript, true);
  assert.deepEqual(before.edges[1], {
    from: "node_modules/alpha",
    section: "dependencies",
    name: "beta",
    spec: "1.0.0",
    optional: false,
  });
  assert.notDeepEqual(before.artifacts, after.artifacts);
  assert.deepEqual(before.artifacts[0], after.artifacts[0]);
  assert.equal(after.verification, "not-performed");
});

it("retains root script-only changes from the supplied manifest", () => {
  const f = fixture();
  const before = inspectNpmLock(input(f));
  const manifest = { ...f.manifest, scripts: { preinstall: "node setup.js", test: "node --test" } };
  const after = inspectNpmLock({ ...input(f), manifest: bytes(manifest) });
  assert.equal(after.completeness.status, "complete");
  assert.deepEqual(after.artifacts, before.artifacts);
  assert.deepEqual(after.scripts, [
    { packagePath: "", name: "preinstall", command: "node setup.js", origin: "manifest" },
    { packagePath: "", name: "test", command: "node --test", origin: "manifest" },
  ]);
  assert.equal(after.packages[1].hasInstallScript, null);
  assert.equal(after.verification, "not-performed");
});

it("retains package flags and recorded dependency scripts while keeping manifest root scripts authoritative", () => {
  const f = fixture();
  Object.assign(f.lock.packages["node_modules/alpha"], {
    dev: true,
    optional: true,
    devOptional: true,
    hasShrinkwrap: true,
    hasInstallScript: false,
    scripts: { install: "node dep-install.js" },
  });
  f.lock.packages[""].scripts = { install: "stale root script" };
  const report = inspectNpmLock({
    ...input(f),
    manifest: bytes({ ...f.manifest, scripts: { install: "node root.js" } }),
  });
  assert.deepEqual(report.packages[1].flags, {
    dev: true,
    optional: true,
    devOptional: true,
    inBundle: false,
    hasShrinkwrap: true,
  });
  assert.equal(report.packages[1].hasInstallScript, false);
  assert.deepEqual(report.scripts, [
    { packagePath: "", name: "install", command: "node root.js", origin: "manifest" },
    {
      packagePath: "node_modules/alpha",
      name: "install",
      command: "node dep-install.js",
      origin: "lockfile",
    },
  ]);
  assert.ok(report.issues.some((i) => i.code === "nested-shrinkwrap"));
  assert.ok(report.issues.some((i) => i.code === "script-indicator-mismatch"));
  assert.equal(report.completeness.status, "incomplete");
});

it("exposes the inventory boundary even when all supplied records are complete", () => {
  const report = inspectNpmLock(input());
  assert.equal(report.completeness.status, "complete");
  assert.deepEqual(report.limitations, [
    "artifact-content-not-verified",
    "dependency-script-content-not-complete",
    "workspace-manifests-not-supplied",
    "npm-resolution-not-reproduced",
  ]);
  assert.equal(report.verification, "not-performed");
});
