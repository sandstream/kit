import { it } from "node:test";
import assert from "node:assert/strict";
import { inspectNpmLock } from "./npm-lock.js";
import { bytes, fixture, input } from "./npm-lock.test-support.js";

it("inventories workspace records, links and workspace dependency edges without treating links as fetched artifacts", () => {
  const f = fixture();
  const manifest = { ...f.manifest, workspaces: ["packages/*"] };
  f.lock.packages[""].workspaces = manifest.workspaces;
  f.lock.packages["packages/widget"] = {
    name: "@example/widget",
    version: "1.0.0",
    dependencies: { alpha: "^1.0.0" },
    hasInstallScript: true,
  };
  f.lock.packages["node_modules/@example/widget"] = { resolved: "packages/widget", link: true };
  const report = inspectNpmLock({ ...input(f), manifest: bytes(manifest) });
  assert.equal(report.completeness.status, "complete");
  assert.deepEqual(report.workspaces, { patterns: ["packages/*"], packages: ["packages/widget"] });
  assert.deepEqual(report.links, [
    { path: "node_modules/@example/widget", target: "packages/widget" },
  ]);
  assert.equal(report.artifacts.length, 1);
  assert.ok(report.edges.some((e) => e.from === "packages/widget" && e.name === "alpha"));
  assert.equal(report.packages.find((p) => p.path === "packages/widget")?.hasInstallScript, true);
  assert.equal(
    report.packages.find((p) => p.path === "node_modules/@example/widget")?.name,
    "@example/widget",
  );
});

it("reports escaping package, workspace and link paths without normalizing away the evidence", () => {
  for (const escape of [
    "../outside",
    "/absolute",
    "C:/outside",
    "packages/../../outside",
    "packages\\outside",
    "%2e%2e/outside",
    "packages/%2foutside",
  ]) {
    const f = fixture();
    const manifest = { ...f.manifest, workspaces: [escape] };
    f.lock.packages[""].workspaces = [escape];
    f.lock.packages[escape] = { name: "outside", version: "1.0.0" };
    f.lock.packages["node_modules/outside"] = { resolved: escape, link: true };
    const report = inspectNpmLock({ ...input(f), manifest: bytes(manifest) });
    assert.equal(report.completeness.status, "incomplete", escape);
    assert.ok(
      report.issues.some((i) => i.code === "invalid-package-path"),
      escape,
    );
    assert.ok(
      report.issues.some((i) => i.code === "invalid-workspace-path"),
      escape,
    );
    assert.ok(
      report.issues.some((i) => i.code === "invalid-link-path"),
      escape,
    );
    assert.deepEqual(report.links, [{ path: "node_modules/outside", target: escape }]);
  }
});

it("reports dangling links, link chains, conflicting link metadata and unsupported workspace patterns", () => {
  const f = fixture();
  const manifest = { ...f.manifest, workspaces: ["packages/**"] };
  f.lock.packages[""].workspaces = manifest.workspaces;
  f.lock.packages["node_modules/missing"] = { link: true, resolved: "packages/missing" };
  f.lock.packages["node_modules/chain"] = { link: true, resolved: "node_modules/missing" };
  f.lock.packages["node_modules/conflict"] = {
    link: true,
    resolved: "node_modules/alpha",
    integrity: "hidden-artifact",
  };
  const report = inspectNpmLock({ ...input(f), manifest: bytes(manifest) });
  assert.equal(report.completeness.status, "incomplete");
  for (const code of [
    "missing-link-target",
    "unsupported-link-target",
    "invalid-link-record",
    "unsupported-workspace-pattern",
  ]) {
    assert.ok(
      report.issues.some((i) => i.code === code),
      code,
    );
  }
  assert.equal(report.links.length, 3);
});

it("refuses workspace records that hide fetched metadata, omit identity or omit a literal workspace", () => {
  const f = fixture();
  const manifest = { ...f.manifest, workspaces: ["packages/hidden", "packages/missing"] };
  f.lock.packages[""].workspaces = manifest.workspaces;
  f.lock.packages["packages/hidden"] = {
    resolved: "https://example.test/hidden.tgz",
    integrity: "tampered",
  };
  const report = inspectNpmLock({ ...input(f), manifest: bytes(manifest) });
  assert.equal(report.completeness.status, "incomplete");
  for (const code of [
    "invalid-workspace-record",
    "missing-workspace-record",
    "missing-package-identity",
    "invalid-integrity",
  ]) {
    assert.ok(
      report.issues.some((i) => i.code === code),
      code,
    );
  }
  assert.ok(report.artifacts.some((a) => a.resolved === "https://example.test/hidden.tgz"));
});

for (const version of [2, 3]) {
  for (const lockfileName of ["package-lock.json", "npm-shrinkwrap.json"] as const) {
    for (const operator of ["@", "+"]) {
      it(`reports unsupported ${operator}() workspaces in v${version} ${lockfileName}`, () => {
        const f = fixture();
        f.lock.lockfileVersion = version;
        const manifest = { ...f.manifest, workspaces: [`packages/*/${operator}(a|b)`] };
        f.lock.packages[""].workspaces = manifest.workspaces;
        const report = inspectNpmLock({ ...input(f), manifest: bytes(manifest), lockfileName });
        assert.equal(report.completeness.status, "incomplete");
        for (const file of ["package.json", lockfileName]) {
          assert.ok(
            report.issues.some(
              (issue) => issue.file === file && issue.code === "unsupported-workspace-pattern",
            ),
          );
        }
      });
    }
  }
}

it("retains supported literal at and plus characters and whole-segment stars", () => {
  for (const path of ["packages/@scope/widget", "packages/foo+bar", "packages/plain(group)"]) {
    const f = fixture();
    const manifest = { ...f.manifest, workspaces: [path, "unmatched/*"] };
    f.lock.packages[""].workspaces = manifest.workspaces;
    f.lock.packages[path] = { name: "widget", version: "1.0.0" };
    const report = inspectNpmLock({ ...input(f), manifest: bytes(manifest) });
    assert.equal(report.completeness.status, "complete", path);
    assert.deepEqual(report.workspaces.packages, [path]);
    assert.equal(report.verification, "not-performed");
  }
});
