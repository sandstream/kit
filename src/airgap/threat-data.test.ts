import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import {
  parseManifest,
  sha256Hex,
  verifyThreatData,
  type ThreatManifest,
  type VerifyDeps,
} from "./threat-data.js";

function deps(dir: string, publicKeyPem: string): VerifyDeps {
  return {
    dir,
    publicKeyPem,
    readFile: (rel) => readFileSync(join(dir, rel)),
    resolvePath: (rel) => resolve(dir, rel),
  };
}

/** Build a signed bundle in a tmp dir; returns {dir, pub}. */
function makeBundle(artifacts: { path: string; bytes: string; env?: string }[]) {
  const dir = mkdtempSync(join(tmpdir(), "kit-td-"));
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  for (const a of artifacts) writeFileSync(join(dir, a.path), a.bytes);
  const manifest: ThreatManifest = {
    version: 1,
    created: new Date().toISOString(),
    artifacts: artifacts.map((a) => ({
      path: a.path,
      sha256: sha256Hex(Buffer.from(a.bytes)),
      env: a.env,
    })),
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2));
  writeFileSync(join(dir, "manifest.json"), manifestBytes);
  const sig = cryptoSign(null, manifestBytes, privateKey).toString("base64");
  writeFileSync(join(dir, "manifest.json.sig"), sig);
  return { dir, pub: publicKey.export({ type: "spki", format: "pem" }) as string };
}

describe("parseManifest", () => {
  it("rejects bad json, missing fields, bad sha, path escape", () => {
    assert.throws(() => parseManifest("{nope"), /not valid JSON/);
    assert.throws(() => parseManifest(JSON.stringify({ artifacts: [] })), /version/);
    assert.throws(
      () => parseManifest(JSON.stringify({ version: 1, artifacts: [{ path: "a", sha256: "xx" }] })),
      /sha256/,
    );
    assert.throws(
      () =>
        parseManifest(
          JSON.stringify({
            version: 1,
            artifacts: [{ path: "../escape", sha256: "a".repeat(64) }],
          }),
        ),
      /escapes the bundle/,
    );
  });
});

describe("verifyThreatData", () => {
  it("verifies a correctly signed bundle and returns the env wiring", () => {
    const { dir, pub } = makeBundle([
      { path: "grype.db", bytes: "fake-grype-db", env: "GRYPE_DB_CACHE_DIR" },
      { path: "osv.db", bytes: "fake-osv-db" },
    ]);
    try {
      const r = verifyThreatData(deps(dir, pub));
      assert.ok(r.ok);
      assert.equal(r.ok && r.artifacts, 2);
      assert.equal(r.ok && r.env.GRYPE_DB_CACHE_DIR, resolve(dir, "grype.db"));
      assert.ok(r.ok && !("OSV" in r.env)); // no env declared for osv.db
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("FAILS CLOSED on a tampered artifact", () => {
    const { dir, pub } = makeBundle([{ path: "grype.db", bytes: "fake-grype-db" }]);
    try {
      writeFileSync(join(dir, "grype.db"), "tampered!"); // change bytes after signing
      const r = verifyThreatData(deps(dir, pub));
      assert.equal(r.ok, false);
      assert.match(r.ok === false ? r.reason : "", /tampered|mismatch/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("FAILS CLOSED on a bad signature / wrong key", () => {
    const { dir } = makeBundle([{ path: "a.db", bytes: "x" }]);
    const other = generateKeyPairSync("ed25519").publicKey.export({
      type: "spki",
      format: "pem",
    }) as string;
    try {
      const r = verifyThreatData(deps(dir, other)); // verify with the WRONG key
      assert.equal(r.ok, false);
      assert.match(r.ok === false ? r.reason : "", /signature/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("FAILS CLOSED on a missing artifact", () => {
    const { dir, pub } = makeBundle([{ path: "a.db", bytes: "x" }]);
    try {
      rmSync(join(dir, "a.db"));
      const r = verifyThreatData(deps(dir, pub));
      assert.equal(r.ok, false);
      assert.match(r.ok === false ? r.reason : "", /missing/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("FAILS CLOSED when the manifest or signature file is absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-td-empty-"));
    try {
      const r = verifyThreatData(deps(dir, "not-a-key"));
      assert.equal(r.ok, false);
      assert.match(r.ok === false ? r.reason : "", /manifest\.json not found/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
