import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bindIncomingCandidate } from "./candidate.js";
import { inspectNpmArtifact, type NpmArtifactResult } from "./npm-artifact.js";
import { artifactVectors } from "./npm-artifact.test-support.js";
import { inspectNpmLock, type NpmLockInventory } from "./npm-lock.js";

const SNAPSHOT = "a".repeat(64);
const RESOLVED = "https://registry.npmjs.org/@scope/real/-/real-1.2.3.tgz";

function lock(extra: Record<string, Record<string, unknown>> = {}): NpmLockInventory {
  const manifest = {
    name: "app",
    version: "1.0.0",
    dependencies: { compat: "npm:@scope/real@1.2.3" },
  };
  const packages: Record<string, Record<string, unknown>> = {
    "": manifest,
    "node_modules/compat": {
      name: "@scope/real",
      version: "1.2.3",
      resolved: RESOLVED,
      integrity: artifactVectors.valid.integrity,
    },
    ...extra,
  };
  return inspectNpmLock({
    manifest: Buffer.from(JSON.stringify(manifest)),
    lockfile: Buffer.from(
      JSON.stringify({ name: "app", version: "1.0.0", lockfileVersion: 3, packages }),
    ),
    lockfileName: "package-lock.json",
  });
}

function verified(inventory: NpmLockInventory): NpmArtifactResult[] {
  return inventory.artifacts.map((artifact) =>
    inspectNpmArtifact(Buffer.from(artifactVectors.valid.base64, "base64"), artifact),
  );
}

describe("bindIncomingCandidate", () => {
  it("binds a snapshot, a complete inventory and verified artifacts into one digest", () => {
    const inventory = lock();
    const result = bindIncomingCandidate({
      snapshotDigest: SNAPSHOT,
      inventory,
      artifacts: verified(inventory),
    });
    assert.equal(result.status, "bound");
    if (result.status !== "bound") return;
    assert.match(result.candidateDigest, /^[0-9a-f]{64}$/);
    assert.deepEqual(
      result.checks.map((c) => [c.id, c.status]),
      [
        ["snapshot", "pass"],
        ["npm-artifacts", "pass"],
      ],
    );
    const again = bindIncomingCandidate({
      snapshotDigest: SNAPSHOT,
      inventory,
      artifacts: verified(inventory),
    });
    assert.deepEqual(again, result);
  });

  it("changes the digest when the snapshot changes", () => {
    const inventory = lock();
    const a = bindIncomingCandidate({
      snapshotDigest: SNAPSHOT,
      inventory,
      artifacts: verified(inventory),
    });
    const b = bindIncomingCandidate({
      snapshotDigest: "b".repeat(64),
      inventory,
      artifacts: verified(inventory),
    });
    assert.equal(a.status, "bound");
    assert.equal(b.status, "bound");
    if (a.status === "bound" && b.status === "bound")
      assert.notEqual(a.candidateDigest, b.candidateDigest);
  });
});

describe("bindIncomingCandidate refusals", () => {
  it("refuses a malformed snapshot digest", () => {
    const inventory = lock();
    for (const snapshotDigest of ["", "A".repeat(64), "a".repeat(63), "g".repeat(64)]) {
      assert.deepEqual(
        bindIncomingCandidate({ snapshotDigest, inventory, artifacts: verified(inventory) }),
        {
          status: "refused",
          reason: "invalid-snapshot-digest",
        },
      );
    }
  });

  it("refuses an incomplete inventory", () => {
    const inventory = lock();
    const incomplete = {
      ...inventory,
      completeness: { ...inventory.completeness, status: "incomplete" as const },
    };
    assert.deepEqual(
      bindIncomingCandidate({
        snapshotDigest: SNAPSHOT,
        inventory: incomplete,
        artifacts: verified(inventory),
      }),
      {
        status: "refused",
        reason: "inventory-incomplete",
      },
    );
  });

  it("refuses a missing, rejected, duplicate or unexpected artifact result", () => {
    const inventory = lock();
    const [ok] = verified(inventory);
    const cases: [NpmArtifactResult[], string][] = [
      [[], "artifact-missing"],
      [[{ status: "rejected", reason: "digest-mismatch" }], "artifact-not-verified"],
      [[ok, ok], "artifact-duplicate"],
      [
        [
          ok,
          {
            ...ok,
            selection: {
              ...(ok as { selection: object }).selection,
              packagePath: "node_modules/other",
            },
          } as NpmArtifactResult,
        ],
        "artifact-unexpected",
      ],
    ];
    for (const [artifacts, reason] of cases) {
      assert.deepEqual(bindIncomingCandidate({ snapshotDigest: SNAPSHOT, inventory, artifacts }), {
        status: "refused",
        reason,
      });
    }
  });

  it("refuses a result whose selection differs from the inventory entry", () => {
    const inventory = lock();
    const [ok] = verified(inventory);
    if (ok.status !== "verified") throw new Error("fixture");
    const swapped = { ...ok, selection: { ...ok.selection, version: "9.9.9" } };
    assert.deepEqual(
      bindIncomingCandidate({ snapshotDigest: SNAPSHOT, inventory, artifacts: [swapped] }),
      {
        status: "refused",
        reason: "artifact-selection-mismatch",
      },
    );
  });
});

describe("bindIncomingCandidate sources and ordering", () => {
  it("refuses git, local and bundled sources instead of skipping them", () => {
    for (const [source, resolved] of [
      ["git", "git+ssh://git@github.com/x/y.git#abc"],
      ["local", "file:../local"],
    ] as const) {
      const inventory = lock({
        "node_modules/extra": {
          version: "1.0.0",
          resolved,
          integrity: artifactVectors.valid.integrity,
        },
      });
      const result = bindIncomingCandidate({
        snapshotDigest: SNAPSHOT,
        inventory,
        artifacts: verified(lock()),
      });
      assert.equal(result.status, "refused", source);
      if (result.status === "refused")
        assert.match(result.reason, /^artifact-source-unsupported|inventory-incomplete$/);
    }
    const inventory = lock({ "node_modules/bund": { version: "1.0.0", inBundle: true } });
    const result = bindIncomingCandidate({
      snapshotDigest: SNAPSHOT,
      inventory,
      artifacts: verified(lock()),
    });
    assert.equal(result.status, "refused");
  });

  it("binds a complete empty artifact set only when the inventory lists none", () => {
    const manifest = { name: "app", version: "1.0.0" };
    const inventory = inspectNpmLock({
      manifest: Buffer.from(JSON.stringify(manifest)),
      lockfile: Buffer.from(
        JSON.stringify({
          name: "app",
          version: "1.0.0",
          lockfileVersion: 3,
          packages: { "": manifest },
        }),
      ),
      lockfileName: "package-lock.json",
    });
    assert.equal(inventory.artifacts.length, 0);
    assert.equal(
      bindIncomingCandidate({ snapshotDigest: SNAPSHOT, inventory, artifacts: [] }).status,
      "bound",
    );
  });

  it("does not change the digest when artifact results arrive in another order", () => {
    const extra = {
      "node_modules/second": {
        name: "@scope/real",
        version: "1.2.3",
        resolved: RESOLVED,
        integrity: artifactVectors.valid.integrity,
      },
    };
    const inventory = lock(extra);
    const results = verified(inventory);
    assert.equal(results.length, 2);
    const a = bindIncomingCandidate({ snapshotDigest: SNAPSHOT, inventory, artifacts: results });
    const b = bindIncomingCandidate({
      snapshotDigest: SNAPSHOT,
      inventory,
      artifacts: [...results].reverse(),
    });
    assert.deepEqual(a, b);
  });
});
