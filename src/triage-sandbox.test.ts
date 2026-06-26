import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isRegistrySpec, isUnsafeEntry } from "./triage-sandbox.js";

describe("isRegistrySpec (reject non-registry npm pack specs)", () => {
  it("accepts plain and scoped registry names", () => {
    assert.equal(isRegistrySpec("left-pad"), true);
    assert.equal(isRegistrySpec("left-pad@1.3.0"), true);
    assert.equal(isRegistrySpec("@scope/pkg"), true);
    assert.equal(isRegistrySpec("@scope/pkg@2.0.0-beta.1"), true);
    assert.equal(isRegistrySpec("@scope/pkg@latest"), true);
  });

  it("rejects git / http / file / protocol specs (would run prepare scripts)", () => {
    assert.equal(isRegistrySpec("git+https://github.com/a/b.git"), false);
    assert.equal(isRegistrySpec("git@github.com:a/b.git"), false);
    assert.equal(isRegistrySpec("https://example.com/x.tgz"), false);
    assert.equal(isRegistrySpec("http://example.com/x"), false);
    assert.equal(isRegistrySpec("file:../local-pkg"), false);
    assert.equal(isRegistrySpec("github:a/b"), false);
  });

  it("rejects local paths and tarball files", () => {
    assert.equal(isRegistrySpec("/abs/path"), false);
    assert.equal(isRegistrySpec("./rel/path"), false);
    assert.equal(isRegistrySpec("../up"), false);
    assert.equal(isRegistrySpec("pkg.tgz"), false);
    assert.equal(isRegistrySpec("pkg.tar"), false);
  });

  it("rejects empty and overlong specs", () => {
    assert.equal(isRegistrySpec(""), false);
    assert.equal(isRegistrySpec("a".repeat(300)), false);
  });
});

describe("isUnsafeEntry (reject escaping / link tarball entries)", () => {
  const file = (mode: string, path: string) =>
    `${mode}  0 user group  123 2020-01-01 00:00 ${path}`;

  it("allows normal files under package/", () => {
    assert.equal(isUnsafeEntry(file("-rw-r--r--", "package/index.js")), false);
    assert.equal(isUnsafeEntry(file("drwxr-xr-x", "package/lib/")), false);
    assert.equal(isUnsafeEntry(""), false);
  });

  it("rejects path traversal and absolute entries", () => {
    assert.equal(isUnsafeEntry(file("-rw-r--r--", "package/../../etc/cron.d/x")), true);
    assert.equal(isUnsafeEntry(file("-rw-r--r--", "/etc/passwd")), true);
    assert.equal(isUnsafeEntry(file("-rw-r--r--", "C:\\windows\\evil")), true);
  });

  it("rejects symlinks and hardlinks regardless of target", () => {
    assert.equal(
      isUnsafeEntry("lrwxr-xr-x  0 user group  0 2020-01-01 00:00 package/evil -> /etc/passwd"),
      true,
    );
    assert.equal(
      isUnsafeEntry("hrw-r--r--  0 user group  0 2020-01-01 00:00 package/link link to package/x"),
      true,
    );
  });
});
