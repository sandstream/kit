import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inspectNpmTarball } from "./npm-artifact-archive.js";
import { artifactVectors } from "./npm-artifact.test-support.js";
import { archive } from "./npm-artifact-archive.test-support.js";

const valid = Buffer.from(artifactVectors.valid.base64, "base64");

describe("inspectNpmTarball", () => {
  it("verifies a well-formed package archive", () => {
    const result = inspectNpmTarball(valid);
    assert.equal(result.status, "verified");
    assert.ok(
      result.status === "verified" && result.entryCount === artifactVectors.valid.entryCount,
    );
    assert.ok(
      result.status === "verified" &&
        result.uncompressedBytes === artifactVectors.valid.uncompressedBytes,
    );
  });

  it("refuses input that is not a Buffer", () => {
    const result = inspectNpmTarball(new Uint8Array(valid) as unknown as Buffer);
    assert.deepEqual(result, { status: "rejected", reason: "invalid-bytes" });
  });

  it("refuses bytes that are not a gzip archive", () => {
    assert.notEqual(inspectNpmTarball(Buffer.from("not an archive")).status, "verified");
  });

  it("refuses a truncated archive", () => {
    assert.notEqual(inspectNpmTarball(valid.subarray(0, 100)).status, "verified");
  });

  it("exposes no entry bytes when validation fails after reading a file", () => {
    const incomplete = archive([{ path: "package/index.js", body: "module.exports = 1;" }]);
    const result = inspectNpmTarball(incomplete, {}, () =>
      assert.fail("incomplete archive exposed bytes"),
    );
    assert.deepEqual(result, { status: "rejected", reason: "manifest-missing" });
  });

  it("lets a caller lower a limit, so the same archive is then refused", () => {
    const result = inspectNpmTarball(valid, { entries: 1 });
    assert.notEqual(result.status, "verified");
  });

  it("refuses a limit above the default, a zero limit and an unknown limit name", () => {
    const invalid = { status: "rejected", reason: "invalid-limits" };
    assert.deepEqual(inspectNpmTarball(valid, { entries: 10_001 }), invalid);
    assert.deepEqual(inspectNpmTarball(valid, { entries: 0 }), invalid);
    assert.deepEqual(inspectNpmTarball(valid, { bogus: 1 } as never), invalid);
  });
});
