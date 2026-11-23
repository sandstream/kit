import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inspectNpmTarball } from "./npm-artifact-archive.js";

import { archive, type Entry } from "./npm-artifact-archive.test-support.js";

const manifest: Entry = { path: "package/package.json", body: '{"name":"a","version":"1.0.0"}' };
const reason = (entries: Entry[]) => {
  const result = inspectNpmTarball(archive(entries));
  return result.status === "verified" ? "verified" : result.reason;
};

describe("inspectNpmTarball path folding", () => {
  it("verifies a plain archive built by the test helper (control)", () => {
    assert.equal(reason([manifest, { path: "package/index.js", body: "1" }]), "verified");
  });

  it("refuses two files whose names differ only in case", () => {
    const entries = [manifest, { path: "package/index.js" }, { path: "package/Index.js" }];
    assert.equal(reason(entries), "path-conflict");
  });

  it("refuses a second manifest spelled in another case", () => {
    const entries = [manifest, { path: "package/Package.json", body: '{"name":"b"}' }];
    assert.equal(reason(entries), "path-conflict");
  });

  it("refuses names that differ only in Unicode normalization form", () => {
    const composed = "package/café.js";
    const decomposed = "package/café.js";
    assert.equal(reason([manifest, { path: composed }, { path: decomposed }]), "path-conflict");
  });

  it("refuses a long s and an s, which Unicode case folding treats as one letter", () => {
    const entries = [manifest, { path: "package/s.js" }, { path: "package/\u017f.js" }];
    assert.equal(reason(entries), "path-conflict");
  });

  it("refuses a letter with a combining mark against its composed form in another case", () => {
    const entries = [manifest, { path: "package/J\u030c.js" }, { path: "package/\u01f0.js" }];
    assert.equal(reason(entries), "path-conflict");
  });

  it("refuses names that differ only in a compatibility form", () => {
    const entries = [manifest, { path: "package/a.js" }, { path: "package/\uff41.js" }];
    assert.equal(reason(entries), "path-conflict");
  });

  it("refuses a file and a directory that collide after case folding", () => {
    const entries = [manifest, { path: "package/lib", body: "x" }, { path: "package/LIB/a.js" }];
    assert.equal(reason(entries), "path-conflict");
  });

  it("still reports an exact duplicate as a duplicate", () => {
    const entries = [manifest, { path: "package/a.js" }, { path: "package/a.js" }];
    assert.equal(reason(entries), "path-duplicate");
  });
});
