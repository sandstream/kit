import assert from "node:assert/strict";
import { it } from "node:test";
import { inspectNpmArtifact } from "./npm-artifact.js";
import { artifactVectors } from "./npm-artifact.test-support.js";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { inspectNpmLock } from "./npm-lock.js";

const selected = {
  packagePath: "node_modules/compat",
  name: "@scope/real",
  version: "1.2.3",
  source: "registry-tarball",
  resolved: "https://registry.npmjs.org/@scope/real/-/real-1.2.3.tgz",
  integrity:
    "sha512-3a81oZNherrMQXNJriBBMRLm+k6JqX6iCp7u5ktV05ohkpkqJ0/BqDa6PCOj/uu9RU1EI2Q86A4qmslPpUyknw==",
};

it("refuses missing selection fields without artifact interpretation or name resolution", () => {
  for (const selection of [
    null,
    [],
    {},
    { ...selected, name: null },
    { ...selected, version: null },
    { ...selected, resolved: null },
    { ...selected, integrity: null },
    { ...selected, packagePath: "" },
  ]) {
    assert.deepEqual(inspectNpmArtifact(Buffer.from("abc"), selection), {
      status: "rejected",
      reason: "invalid-artifact-selection",
    });
  }
});

it("verifies exact compressed bytes and the real alias identity through the complete interface", () => {
  const vector = artifactVectors.valid;
  const selection = { ...selected, integrity: vector.integrity };
  const result = inspectNpmArtifact(Buffer.from(vector.base64, "base64"), selection);
  assert.equal(result.status, "verified");
  if (result.status !== "verified") return;
  assert.deepEqual(result.selection, selection);
  assert.equal(result.scope, "exact-npm-artifact");
  assert.deepEqual(result.archive, { root: "package", entryCount: 2, uncompressedBytes: 10240 });
  assert.deepEqual(result.manifest, {
    name: "@scope/real",
    version: "1.2.3",
    scripts: { install: "node install.js" },
  });
  assert.equal(result.integrity.actualDigest, vector.integrity.slice(7));
  assert.equal(result.integrity.byteCount, vector.compressedBytes);
});

it("keeps all unsupported source kinds visible instead of verifying them as registry artifacts", () => {
  for (const source of [
    "git",
    "local-tarball",
    "local-directory",
    "bundled",
    "unknown",
    "future-source",
  ]) {
    assert.deepEqual(
      inspectNpmArtifact(Buffer.from(artifactVectors.valid.base64, "base64"), {
        ...selected,
        source,
        integrity: artifactVectors.valid.integrity,
      }),
      {
        status: "unsupported",
        reason: "unsupported-artifact-source",
      },
    );
  }
});

it("copies selection and byte input before hashing and excludes unrelated caller properties", (t) => {
  const vector = artifactVectors.valid;
  const input = Buffer.from(vector.base64, "base64");
  const selection: typeof selected = { ...selected, integrity: vector.integrity };
  const original = { ...selection };
  Object.defineProperty(selection, "unrelated", {
    enumerable: true,
    get() {
      throw new Error("Unrelated caller property must not execute");
    },
  });
  const nativeHash = crypto.createHash;
  const boundary = t.mock.method(
    crypto,
    "createHash",
    (algorithm: string, options?: crypto.HashOptions) => {
      input.fill(0);
      selection.name = "mutated";
      selection.integrity = "mutated";
      selection.resolved = "https://other.invalid/replacement.tgz";
      return nativeHash(algorithm, options);
    },
  );
  syncBuiltinESMExports();
  try {
    const result = inspectNpmArtifact(input, selection);
    assert.equal(result.status, "verified");
    if (result.status !== "verified") return;
    assert.deepEqual(result.selection, original);
    assert.equal(result.manifest.name, "@scope/real");
    assert.equal(result.integrity.actualDigest, vector.integrity.slice(7));
    assert.equal(
      input.every((byte) => byte === 0),
      true,
    );
  } finally {
    boundary.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(
    inspectNpmArtifact(Buffer.from(vector.base64, "base64"), original).status,
    "verified",
  );
});

it("refuses unsafe package locations, invalid names, and nonexact selected versions", () => {
  const base = { ...selected, integrity: artifactVectors.valid.integrity };
  const cases = [
    ...[
      "../node_modules/compat",
      "/node_modules/compat",
      "C:/node_modules/compat",
      "node_modules\\compat",
      "node_modules/./compat",
      "node_modules//compat",
      "node_modules/a*",
      "x".repeat(4097),
    ].map((packagePath) => ({ packagePath })),
    ...["@scope", "../escape", "a/b/c", "bad name"].map((name) => ({ name })),
    ...["latest", "^1.2.3", ">=1.2.3", "1.2", "01.2.3", "1.2.3-01", "1.2.3 "].map((version) => ({
      version,
    })),
  ];
  for (const delta of cases) {
    assert.deepEqual(
      inspectNpmArtifact(Buffer.from(artifactVectors.valid.base64, "base64"), {
        ...base,
        ...delta,
      }),
      {
        status: "rejected",
        reason: "invalid-artifact-selection",
      },
      JSON.stringify(delta),
    );
  }
});

it("preserves source kind meaning and rejects inaccurate registry labels", () => {
  for (const delta of [
    { source: "registry-tarball", resolved: "https://mirror.invalid/exact.tgz" },
    { source: "remote-tarball", resolved: selected.resolved },
  ]) {
    assert.deepEqual(
      inspectNpmArtifact(Buffer.from(artifactVectors.valid.base64, "base64"), {
        ...selected,
        integrity: artifactVectors.valid.integrity,
        ...delta,
      }),
      {
        status: "rejected",
        reason: "artifact-source-mismatch",
      },
    );
  }
  assert.equal(
    inspectNpmArtifact(Buffer.from(artifactVectors.valid.base64, "base64"), {
      ...selected,
      integrity: artifactVectors.valid.integrity,
      source: "remote-tarball",
      resolved: "https://mirror.invalid/exact.tgz?value=one%2Ftwo",
    }).status,
    "verified",
  );
});

it("consumes the actual lock inventory without resolving aliases or hiding unsupported sources", () => {
  const manifest = {
    name: "fixture",
    version: "1.0.0",
    dependencies: { compat: "npm:@scope/real@1.2.3" },
  };
  for (const lockfileVersion of [2, 3]) {
    const inventory = inspectNpmLock({
      manifest: Buffer.from(JSON.stringify(manifest)),
      lockfile: Buffer.from(
        JSON.stringify({
          name: manifest.name,
          version: manifest.version,
          lockfileVersion,
          packages: {
            "": manifest,
            "node_modules/compat": {
              name: "@scope/real",
              version: "1.2.3",
              resolved: selected.resolved,
              integrity: artifactVectors.valid.integrity,
            },
          },
          dependencies: { decoy: { version: "9.9.9" } },
        }),
      ),
      lockfileName: "package-lock.json",
    });
    assert.equal(inventory.completeness.status, "complete", JSON.stringify(inventory.issues));
    assert.equal(inventory.artifacts.length, 1);
    const result = inspectNpmArtifact(
      Buffer.from(artifactVectors.valid.base64, "base64"),
      inventory.artifacts[0],
    );
    assert.equal(result.status, "verified");
    if (result.status === "verified")
      assert.equal(result.selection.packagePath, "node_modules/compat");
  }
  for (const source of ["git", "local-tarball", "local-directory", "bundled", "unknown"]) {
    assert.deepEqual(
      inspectNpmArtifact(Buffer.alloc(0), {
        ...selected,
        source,
        name: null,
        version: null,
        resolved: null,
        integrity: null,
      }),
      {
        status: "unsupported",
        reason: "unsupported-artifact-source",
      },
    );
  }
});

it("refuses byte changes before archive parsing and rejects correctly hashed wrong manifests", () => {
  const vector = artifactVectors.valid;
  const original = Buffer.from(vector.base64, "base64");
  const selection = { ...selected, integrity: vector.integrity };
  const changedHeader = Buffer.from(original);
  changedHeader[4] ^= 1;
  for (const bytes of [Buffer.from("different"), original.subarray(0, -1), changedHeader]) {
    assert.deepEqual(inspectNpmArtifact(bytes, selection), {
      status: "rejected",
      reason: "digest-mismatch",
    });
  }
  for (const bad of [artifactVectors.wrongName, artifactVectors.wrongVersion]) {
    assert.deepEqual(
      inspectNpmArtifact(Buffer.from(bad.base64, "base64"), {
        ...selected,
        integrity: bad.integrity,
      }),
      { status: "rejected", reason: "manifest-identity-mismatch" },
    );
  }
  const bad = artifactVectors.invalidScripts;
  assert.deepEqual(
    inspectNpmArtifact(Buffer.from(bad.base64, "base64"), {
      ...selected,
      integrity: bad.integrity,
    }),
    { status: "rejected", reason: "invalid-manifest-scripts" },
  );
  assert.deepEqual(inspectNpmArtifact(Buffer.from("abc"), selected), {
    status: "unsupported",
    reason: "compression-format",
  });
});

it("enforces compressed byte limits and input types before native hashing", () => {
  for (const bytes of [null, undefined, "abc", new Uint8Array([1]), {}]) {
    assert.deepEqual(Reflect.apply(inspectNpmArtifact, undefined, [bytes, selected]), {
      status: "rejected",
      reason: "invalid-artifact-bytes",
    });
  }
  assert.deepEqual(inspectNpmArtifact(Buffer.alloc(16 * 1024 * 1024 + 1), selected), {
    status: "unsupported",
    reason: "compressed-limit",
  });
  assert.deepEqual(inspectNpmArtifact(Buffer.alloc(16 * 1024 * 1024), selected), {
    status: "rejected",
    reason: "digest-mismatch",
  });
});

it("does not inspect a selected URL with credentials, fragments, or path normalization", () => {
  const selection = { ...selected, integrity: artifactVectors.valid.integrity };
  for (const resolved of [
    "http://registry.npmjs.org/a.tgz",
    "https://u:p@registry.npmjs.org/a.tgz",
    "https://registry.npmjs.org/a.tgz#ignored",
    "https://registry.npmjs.org/a/../b.tgz",
    "https://registry.npmjs.org/a/%2e%2e/b.tgz",
    "https://registry.npmjs.org/a.tgz\n",
  ]) {
    assert.notEqual(
      inspectNpmArtifact(Buffer.from(artifactVectors.valid.base64, "base64"), {
        ...selection,
        resolved,
      }).status,
      "verified",
    );
  }
});
