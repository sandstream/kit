import assert from "node:assert/strict";
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { inspectCandidateArchives, retainCandidateArchives } from "./candidate-artifacts.js";
import { artifactVectors } from "./npm-artifact.test-support.js";
import { snapshotFixture } from "./snapshot.test-support.js";

const vector = artifactVectors.valid;
const selection = {
  packagePath: "node_modules/compat",
  name: "@scope/real",
  version: "1.2.3",
  source: "remote-tarball" as const,
  resolved: "https://registry.example.org/real.tgz",
  integrity: vector.integrity,
};

it("round-trips the exact archive and refuses extra or linked entries", () => {
  const fixture = snapshotFixture();
  try {
    mkdirSync(fixture.destination, { mode: 0o700 });
    const bytes = Buffer.from(vector.base64, "base64");
    retainCandidateArchives(fixture.destination)(bytes);
    const directory = join(fixture.destination, "artifacts");
    const saved = join(directory, "0.tgz");
    const extra = join(directory, "extra.tgz");
    assert.deepEqual(readFileSync(saved), bytes);
    const inspect = () => inspectCandidateArchives(fixture.destination, [selection]);
    assert.equal(inspect()[0]?.status, "verified");

    writeFileSync(extra, bytes, { mode: 0o600 });
    assert.throws(inspect, /unexpected archive/);
    unlinkSync(extra);

    const outside = join(fixture.root, "outside.tgz");
    linkSync(saved, outside);
    assert.throws(inspect, /uncontrolled-copy/);
  } finally {
    fixture.cleanup();
  }
});
