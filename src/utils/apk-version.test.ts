import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compareApkVersions, parseApkVersion } from "./apk-version.js";

describe("apk version ordering", () => {
  it("orders numbers numerically, not as text", () => {
    assert.equal(compareApkVersions("2.8.5-r0", "2.10.0-r0"), -1);
    assert.equal(compareApkVersions("2.10.0-r0", "2.9.0-r0"), 1);
    assert.equal(compareApkVersions("3.5.9-r0", "3.5.9-r0"), 0);
  });

  it("orders revisions, letters and suffixes as apk-tools does", () => {
    assert.equal(compareApkVersions("1.2.3-r1", "1.2.3-r2"), -1);
    assert.equal(compareApkVersions("1.2.3", "1.2.3-r0"), 0);
    assert.equal(compareApkVersions("1.2.3a-r0", "1.2.3-r0"), 1);
    assert.equal(compareApkVersions("1.2.3_rc1-r0", "1.2.3-r0"), -1);
    assert.equal(compareApkVersions("1.2.3_alpha2", "1.2.3_beta1"), -1);
    assert.equal(compareApkVersions("1.2.3_p1-r0", "1.2.3-r9"), 1);
    assert.equal(compareApkVersions("1.2", "1.2.0"), -1);
  });

  it("refuses text that is not an apk version instead of guessing", () => {
    assert.equal(parseApkVersion("$VERSION"), null);
    assert.equal(compareApkVersions("1.2_weird", "1.2"), null);
    assert.equal(compareApkVersions("latest", "1.0"), null);
  });
});
