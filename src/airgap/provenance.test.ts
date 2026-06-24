import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildCosignArgs,
  missingField,
  verifyProvenance,
  type ProvenanceVerifyOptions,
  type ProvenanceDeps,
} from "./provenance.js";

const full: ProvenanceVerifyOptions = {
  artifact: "dist/app.tar.gz",
  bundle: "dist/app.sigstore",
  trustedRoot: "/etc/kit/trusted_root.json",
  certIdentity: "https://github.com/org/repo/.github/workflows/release.yml@refs/tags/v1",
  certIssuer: "https://token.actions.githubusercontent.com",
};

describe("missingField", () => {
  it("returns null when all required fields are present", () => {
    assert.equal(missingField(full), null);
  });
  it("flags the first missing/empty field", () => {
    assert.equal(missingField({ ...full, bundle: "" }), "bundle");
    assert.equal(missingField({ artifact: "a" }), "bundle");
  });
});

describe("buildCosignArgs", () => {
  it("builds an offline verify-blob argv with trust root + identity constraints", () => {
    assert.deepEqual(buildCosignArgs(full), [
      "verify-blob",
      "--offline",
      "--trusted-root",
      "/etc/kit/trusted_root.json",
      "--bundle",
      "dist/app.sigstore",
      "--certificate-identity",
      full.certIdentity,
      "--certificate-oidc-issuer",
      full.certIssuer,
      "dist/app.tar.gz",
    ]);
  });
});

describe("verifyProvenance (fail-closed)", () => {
  const okRun = async () => ({ ok: true, stdout: "Verified OK", stderr: "" });

  it("verifies when cosign exits 0", async () => {
    const deps: ProvenanceDeps = { resolveBin: async () => "/usr/bin/cosign", run: okRun };
    assert.deepEqual(await verifyProvenance(full, deps), { ok: true });
  });

  it("refuses (fail-closed) when a required field is missing", async () => {
    const deps: ProvenanceDeps = { resolveBin: async () => "/usr/bin/cosign", run: okRun };
    const r = await verifyProvenance({ ...full, certIdentity: "" }, deps);
    assert.equal(r.ok, false);
    assert.match(r.ok === false ? r.reason : "", /certIdentity/);
  });

  it("refuses when cosign is not installed", async () => {
    const deps: ProvenanceDeps = { resolveBin: async () => null, run: okRun };
    const r = await verifyProvenance(full, deps);
    assert.equal(r.ok, false);
    assert.match(r.ok === false ? r.reason : "", /cosign not found/);
  });

  it("refuses when cosign rejects the bundle (non-zero)", async () => {
    const deps: ProvenanceDeps = {
      resolveBin: async () => "/usr/bin/cosign",
      run: async () => ({ ok: false, stdout: "", stderr: "error: no matching signatures" }),
    };
    const r = await verifyProvenance(full, deps);
    assert.equal(r.ok, false);
    assert.match(r.ok === false ? r.reason : "", /cosign rejected the bundle/);
  });
});
