import { it } from "node:test";
import assert from "node:assert/strict";
import { inspectNpmLock } from "./npm-lock.js";
import { fixture, input, integrity } from "./npm-lock.test-support.js";

it("exposes missing or malformed integrity and unknown sources on every artifact", () => {
  const f = fixture();
  delete f.lock.packages["node_modules/alpha"].integrity;
  f.lock.packages["node_modules/beta"] = {
    version: "1.0.0",
    resolved: "https://cdn.example.test/beta.tgz",
    integrity: "sha512-short",
  };
  f.lock.packages["node_modules/gamma"] = {
    version: "1.0.0",
    resolved: "custom:opaque",
    integrity,
  };
  f.lock.packages["node_modules/delta"] = { version: "1.0.0" };
  const report = inspectNpmLock(input(f));
  assert.equal(report.completeness.status, "incomplete");
  assert.equal(report.artifacts.length, 4);
  assert.equal(report.artifacts[0].integrity, null);
  assert.equal(report.artifacts[1].integrity, "sha512-short");
  assert.equal(report.artifacts[2].resolved, "custom:opaque");
  assert.deepEqual(
    report.issues.map((i) => i.code),
    ["missing-integrity", "invalid-integrity", "unknown-source", "unknown-source"],
  );
});

it("keeps git, local tarball, bundled and missing-source records explicit and incomplete", () => {
  const f = fixture();
  f.lock.packages["node_modules/git"] = {
    version: "1.0.0",
    resolved: `git+https://example.test/repo.git#${"a".repeat(40)}`,
  };
  f.lock.packages["node_modules/local"] = {
    version: "1.0.0",
    resolved: "file:vendor/local.tgz",
    integrity,
  };
  f.lock.packages["node_modules/bundled"] = { version: "1.0.0", inBundle: true };
  const report = inspectNpmLock(input(f));
  assert.equal(report.completeness.status, "incomplete");
  assert.deepEqual(
    report.artifacts.map((a) => a.source),
    ["registry-tarball", "git", "local-tarball", "bundled"],
  );
  assert.equal(report.issues.filter((i) => i.code === "unsupported-source").length, 3);
  assert.equal(report.verification, "not-performed");
});

it("accepts well-formed SHA1 and SHA512 metadata but never verifies digest content and rejects excess padding", () => {
  const f = fixture();
  for (const digest of [
    `sha1-${Buffer.alloc(20, 7).toString("base64")}`,
    `sha512-${Buffer.alloc(64, 9).toString("base64")}`,
  ]) {
    f.lock.packages["node_modules/alpha"].integrity = digest;
    const report = inspectNpmLock(input(f));
    assert.equal(report.completeness.status, "complete");
    assert.equal(report.artifacts[0].integrity, digest);
    assert.equal(report.verification, "not-performed");
  }
  f.lock.packages["node_modules/alpha"].integrity =
    `sha1-${Buffer.alloc(20, 7).toString("base64")}=`;
  const invalid = inspectNpmLock(input(f));
  assert.equal(invalid.completeness.status, "incomplete");
  assert.ok(invalid.issues.some((i) => i.code === "invalid-integrity"));
});
