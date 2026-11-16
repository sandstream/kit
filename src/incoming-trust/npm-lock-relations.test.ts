import { it } from "node:test";
import assert from "node:assert/strict";
import { inspectNpmLock } from "./npm-lock.js";
import { bytes, fixture, input } from "./npm-lock.test-support.js";

it("reports every root identity and dependency declaration mismatch without discarding artifacts", () => {
  const f = fixture();
  f.lock.packages[""].name = "substituted";
  f.lock.version = "2.0.0";
  f.lock.packages[""].dependencies = { alpha: "^9.0.0" };
  f.lock.packages[""].optionalDependencies = { optional: "1" };
  const manifest = {
    ...f.manifest,
    devDependencies: { dev: "2" },
    peerDependencies: { peer: "3" },
  };
  const report = inspectNpmLock({ ...input(f), manifest: bytes(manifest) });
  assert.equal(report.completeness.status, "incomplete");
  assert.equal(report.artifacts.length, 1);
  assert.equal(report.issues.filter((i) => i.code === "root-identity-mismatch").length, 2);
  assert.deepEqual(
    report.issues
      .filter((i) => i.code === "root-dependency-mismatch")
      .map((i) => i.path)
      .sort(),
    [
      "/packages//dependencies",
      "/packages//devDependencies",
      "/packages//optionalDependencies",
      "/packages//peerDependencies",
    ],
  );
  assert.equal(report.verification, "not-performed");
});

it("reports missing dependency records and tampered explicit identities while preserving npm aliases", () => {
  const f = fixture();
  f.lock.packages["node_modules/alpha"].name = "substituted";
  f.lock.packages["node_modules/alpha"].dependencies = { missing: "1.0.0" };
  const report = inspectNpmLock(input(f));
  assert.equal(report.completeness.status, "incomplete");
  assert.ok(report.issues.some((i) => i.code === "dependency-identity-mismatch"));
  assert.ok(report.issues.some((i) => i.code === "missing-dependency-target"));
  const alias = fixture();
  alias.manifest.dependencies.alpha = "npm:original@1.0.0";
  alias.lock.packages[""].dependencies = alias.manifest.dependencies;
  alias.lock.packages["node_modules/alpha"].name = "original";
  const accepted = inspectNpmLock(input(alias));
  assert.equal(accepted.completeness.status, "complete");
  assert.equal(accepted.artifacts[0].name, "original");
  assert.equal(accepted.edges[0].name, "alpha");
});

it("retains all dependency sections and accepts absent optional dependencies and optional peers", () => {
  const f = fixture();
  const manifest = {
    ...f.manifest,
    optionalDependencies: { omitted: "1" },
    peerDependencies: { peer: "^2" },
    peerDependenciesMeta: { peer: { optional: true } },
  };
  f.lock.packages[""] = { ...manifest };
  const report = inspectNpmLock({ ...input(f), manifest: bytes(manifest) });
  assert.equal(report.completeness.status, "complete");
  assert.deepEqual(
    report.edges.map((e) => [e.section, e.name, e.optional]),
    [
      ["dependencies", "alpha", false],
      ["optionalDependencies", "omitted", true],
      ["peerDependencies", "peer", true],
    ],
  );
  f.lock.packages[""].peerDependenciesMeta = { peer: { optional: "true" } };
  const invalid = inspectNpmLock({ ...input(f), manifest: bytes(manifest) });
  assert.equal(invalid.completeness.status, "incomplete");
  assert.ok(invalid.issues.some((i) => i.code === "invalid-schema"));
});

it("does not let changed peer optional metadata conceal a missing required peer", () => {
  const f = fixture();
  const manifest = { ...f.manifest, peerDependencies: { missing: "1.0.0" } };
  f.lock.packages[""] = { ...manifest, peerDependenciesMeta: { missing: { optional: true } } };
  const report = inspectNpmLock({ ...input(f), manifest: bytes(manifest) });
  assert.equal(report.completeness.status, "incomplete");
  assert.ok(
    report.issues.some(
      (i) => i.code === "root-dependency-mismatch" && i.path === "/packages//peerDependenciesMeta",
    ),
  );
});
