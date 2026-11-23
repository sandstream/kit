import assert from "node:assert/strict";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { captureIncomingCandidate, verifyRetainedIncomingCandidate } from "./candidate-flow.js";
import { artifactVectors } from "./npm-artifact.test-support.js";
import { withHttps } from "./npm-artifact-fetch.test-support.js";
import { snapshotFixture } from "./snapshot.test-support.js";

const vector = artifactVectors.valid;

function project(source: string, origin: string, integrity: string = vector.integrity): void {
  const manifest = {
    name: "app",
    version: "1.0.0",
    dependencies: { compat: "npm:@scope/real@1.2.3" },
  };
  const packages = {
    "": manifest,
    "node_modules/compat": {
      name: "@scope/real",
      version: "1.2.3",
      resolved: `${origin}/real.tgz`,
      integrity,
    },
  };
  writeFileSync(join(source, "package.json"), JSON.stringify(manifest));
  writeFileSync(
    join(source, "package-lock.json"),
    JSON.stringify({ name: "app", version: "1.0.0", lockfileVersion: 3, packages }),
  );
}

describe("captureIncomingCandidate", () => {
  it("captures, fetches over TLS, inspects and binds one candidate end to end", async () => {
    const fixture = snapshotFixture();
    try {
      await withHttps(
        (_request, response) => response.end(Buffer.from(vector.base64, "base64")),
        async ({ origin, caPem }) => {
          project(fixture.source, origin);
          const run = () =>
            captureIncomingCandidate({
              source: fixture.source,
              destination: fixture.destination,
              fetchPolicy: { origins: [origin], caPem },
            });
          const result = await run();
          assert.equal(result.status, "bound", JSON.stringify(result));
          if (result.status !== "bound") return;
          assert.match(result.candidate.candidateDigest, /^[0-9a-f]{64}$/);
          assert.equal(result.candidate.artifactCount, 1);
          assert.equal(result.snapshot.digest, result.candidate.checks[0]?.evidenceDigest);
          assert.deepEqual(
            readFileSync(join(fixture.destination, "artifacts", "0.tgz")),
            Buffer.from(vector.base64, "base64"),
          );
          // A changed source after capture does not change the captured inputs: a second capture
          // of the changed source gets a different identity, and the first stays as bound.
          writeFileSync(join(fixture.source, "extra.txt"), "changed after capture");
          const second = await captureIncomingCandidate({
            source: fixture.source,
            destination: join(fixture.root, "captured-2"),
            fetchPolicy: { origins: [origin], caPem },
          });
          assert.equal(second.status, "bound", JSON.stringify(second));
          if (second.status === "bound") {
            assert.notEqual(second.candidate.candidateDigest, result.candidate.candidateDigest);
          }
        },
      );
    } finally {
      fixture.cleanup();
    }
  });
});

describe("captureIncomingCandidate: download", () => {
  it("refuses when the bytes differ from the locked integrity and names the cause", async () => {
    const fixture = snapshotFixture();
    try {
      await withHttps(
        (_request, response) => response.end(Buffer.from("not the locked archive")),
        async ({ origin, caPem }) => {
          project(fixture.source, origin);
          const result = await captureIncomingCandidate({
            source: fixture.source,
            destination: fixture.destination,
            fetchPolicy: { origins: [origin], caPem },
          });
          assert.equal(result.status, "refused");
          if (result.status !== "refused") return;
          assert.equal(result.reason, "artifact-refused");
          assert.equal(result.artifact?.status, "rejected");
        },
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("refuses when the snapshot is altered while the artifacts download", async () => {
    const fixture = snapshotFixture();
    try {
      await withHttps(
        (_request, response) => {
          writeFileSync(join(fixture.destination, "tree", "package.json"), "{}");
          response.end(Buffer.from(vector.base64, "base64"));
        },
        async ({ origin, caPem }) => {
          project(fixture.source, origin);
          const result = await captureIncomingCandidate({
            source: fixture.source,
            destination: fixture.destination,
            fetchPolicy: { origins: [origin], caPem },
          });
          assert.equal(result.status, "refused");
          if (result.status === "refused") assert.equal(result.reason, "snapshot-changed");
        },
      );
    } finally {
      fixture.cleanup();
    }
  });
});

describe("verifyRetainedIncomingCandidate", () => {
  it("verifies offline and refuses a wrong digest, an altered archive or an incomplete bundle", async () => {
    const fixture = snapshotFixture();
    try {
      const result = await withHttps(
        (_request, response) => response.end(Buffer.from(vector.base64, "base64")),
        async ({ origin, caPem }) => {
          project(fixture.source, origin);
          return captureIncomingCandidate({
            source: fixture.source,
            destination: fixture.destination,
            fetchPolicy: { origins: [origin], caPem },
          });
        },
      );
      assert.equal(result.status, "bound", JSON.stringify(result));
      if (result.status !== "bound") return;
      const expected = {
        snapshotDigest: result.snapshot.digest,
        candidateDigest: result.candidate.candidateDigest,
      };
      writeFileSync(join(fixture.source, "package-lock.json"), "{}");
      const verify = () => verifyRetainedIncomingCandidate(fixture.destination, expected);
      assert.deepEqual(verify(), { ok: true });
      assert.deepEqual(
        verifyRetainedIncomingCandidate(fixture.destination, {
          ...expected,
          candidateDigest: "0".repeat(64),
        }),
        { ok: false, reason: "candidate-changed" },
      );

      const archive = join(fixture.destination, "artifacts", "0.tgz");
      const bytes = readFileSync(archive);
      // Flip the gzip modification time. The archive still extracts to the same files.
      bytes[4] ^= 1;
      writeFileSync(archive, bytes);
      assert.deepEqual(verify(), { ok: false, reason: "candidate-changed" });
      unlinkSync(archive);
      assert.deepEqual(verify(), { ok: false, reason: "artifact-storage" });
    } finally {
      fixture.cleanup();
    }
  });
});

describe("captureIncomingCandidate: input", () => {
  it("refuses a lockfile pointing at a host outside the caller's policy without fetching", async () => {
    const fixture = snapshotFixture();
    let requests = 0;
    try {
      await withHttps(
        (_request, response) => {
          requests += 1;
          response.end(Buffer.from(vector.base64, "base64"));
        },
        async ({ origin, caPem }) => {
          project(fixture.source, origin);
          const result = await captureIncomingCandidate({
            source: fixture.source,
            destination: fixture.destination,
            fetchPolicy: { origins: ["https://other.invalid"], caPem },
          });
          assert.equal(result.status, "refused");
          if (result.status === "refused") assert.equal(result.reason, "artifact-refused");
        },
      );
      assert.equal(requests, 0);
    } finally {
      fixture.cleanup();
    }
  });

  it("refuses input shapes before any download", async () => {
    const policy = { origins: ["https://registry.npmjs.org"] };
    const cases: [string, (source: string) => void, string][] = [
      ["no manifest", () => undefined, "manifest-unreadable"],
      ["no lockfile", (s) => writeFileSync(join(s, "package.json"), "{}"), "lockfile-missing"],
      [
        "two lockfiles",
        (s) => {
          writeFileSync(join(s, "package.json"), "{}");
          writeFileSync(join(s, "package-lock.json"), "{}");
          writeFileSync(join(s, "npm-shrinkwrap.json"), "{}");
        },
        "lockfile-ambiguous",
      ],
      [
        "lockfile is a directory",
        (s) => {
          writeFileSync(join(s, "package.json"), "{}");
          mkdirSync(join(s, "package-lock.json"));
          writeFileSync(join(s, "package-lock.json", "x"), "x");
        },
        "lockfile-unreadable",
      ],
    ];
    for (const [label, setup, reason] of cases) {
      const fixture = snapshotFixture();
      try {
        setup(fixture.source);
        const result = await captureIncomingCandidate({
          source: fixture.source,
          destination: fixture.destination,
          fetchPolicy: policy,
        });
        assert.equal(result.status, "refused", label);
        if (result.status === "refused") assert.equal(result.reason, reason, label);
      } finally {
        fixture.cleanup();
      }
    }
  });
});

describe("captureIncomingCandidate: limits", () => {
  it("returns snapshot-failed for a missing source and enforces the artifact limit", async () => {
    const fixture = snapshotFixture();
    try {
      const missing = await captureIncomingCandidate({
        source: join(fixture.root, "nope"),
        destination: fixture.destination,
        fetchPolicy: { origins: [] },
      });
      assert.deepEqual(missing, { status: "refused", reason: "snapshot-failed" });
      await withHttps(
        (_request, response) => response.end(Buffer.from(vector.base64, "base64")),
        async ({ origin, caPem }) => {
          project(fixture.source, origin);
          const limited = await captureIncomingCandidate({
            source: fixture.source,
            destination: fixture.destination,
            fetchPolicy: { origins: [origin], caPem },
            maxArtifacts: 0,
          });
          assert.equal(limited.status, "refused");
          if (limited.status === "refused") assert.equal(limited.reason, "artifact-limit");
        },
      );
    } finally {
      fixture.cleanup();
    }
  });
});
