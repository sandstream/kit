import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, lstatSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { it } from "node:test";
import { captureIncomingCandidate, verifyRetainedIncomingCandidate } from "./candidate-flow.js";
import { hasNativeImageTool } from "./native-image.test-support.js";
import { preflightSealedCandidate, withSealedRuntime } from "./sealed-candidate.js";
import { ejectReadOnlyImage } from "./sealed-image-macos.js";
import { readSnapshotFile } from "./snapshot-io.js";
import { snapshotFixture } from "./snapshot.test-support.js";

it("does not start materialization on an unsupported platform", () => {
  const host = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    Object.defineProperty(process, "platform", { ...host, value: "linux" });
    const result = preflightSealedCandidate("/unused", () =>
      assert.fail("unexpected verifier call"),
    );
    assert.deepEqual(result, { verified: false, reason: "sealed-platform-unsupported" });
  } finally {
    Object.defineProperty(process, "platform", host);
  }
});

const cases = [
  { timing: "before copy", expected: { verified: false, reason: "snapshot-changed" } },
  { timing: "while mounted", expected: { verified: true, inputs: "read-only-image" } },
];

it(
  "runs the pinned executable after its original pathname changes",
  {
    skip: !hasNativeImageTool || process.arch !== "arm64",
  },
  () => {
    const f = snapshotFixture();
    try {
      const runtime = join(f.root, "node-copy");
      copyFileSync(realpathSync(process.execPath), runtime);
      const { sha256 } = readSnapshotFile(
        runtime,
        lstatSync(runtime, { bigint: true }),
        192 * 1024 * 1024,
      );
      const result = withSealedRuntime(runtime, sha256, (sealed) => {
        assert.notEqual(lstatSync(sealed).dev, lstatSync(runtime).dev);
        writeFileSync(runtime, "changed");
        const probe = spawnSync(sealed, ["--version"], { encoding: "utf8", timeout: 5000 });
        assert.equal(probe.status, 0, String(probe.error) + probe.stderr);
        return probe.stdout.trim();
      });
      assert.equal(result, process.version);
    } finally {
      f.cleanup();
    }
  },
);

for (const { timing, expected } of cases) {
  it(
    `rechecks mounted inputs changed ${timing} and removes the workspace`,
    {
      skip: !hasNativeImageTool,
    },
    async () => {
      const f = snapshotFixture();
      const prior = process.env.TMPDIR;
      process.env.TMPDIR = f.root;
      try {
        const manifest = { name: "sample", version: "1.0.0" };
        writeFileSync(join(f.source, "package.json"), JSON.stringify(manifest));
        writeFileSync(
          join(f.source, "package-lock.json"),
          JSON.stringify({
            ...manifest,
            lockfileVersion: 3,
            packages: { "": manifest },
          }),
        );
        const captured = await captureIncomingCandidate({
          source: f.source,
          destination: f.destination,
          fetchPolicy: { origins: [] },
        });
        if (captured.status !== "bound") assert.fail(captured.reason);
        const digests = {
          snapshotDigest: captured.snapshot.digest,
          candidateDigest: captured.candidate.candidateDigest,
        };
        const paths: string[] = [];
        const result = preflightSealedCandidate(f.destination, (path) => {
          paths.push(path);
          if (path !== f.destination) {
            assert.notEqual(lstatSync(path).dev, lstatSync(f.root).dev);
            if (timing === "while mounted") {
              writeFileSync(join(f.destination, "tree", "package.json"), "{}");
              const work = dirname(path);
              assert.throws(() => ejectReadOnlyImage(join(work, "candidate.dmg"), work));
            }
          }
          const checked = verifyRetainedIncomingCandidate(path, digests);
          if (timing === "before copy" && path === f.destination && checked.ok)
            writeFileSync(join(f.destination, "tree", "package.json"), "{}");
          return checked.ok ? { verified: true } : { verified: false, reason: checked.reason };
        });
        assert.deepEqual(result, expected);
        assert.equal(paths.length, 2);
        assert.equal(lstatSync(paths[1]!, { throwIfNoEntry: false }), undefined);
        assert.deepEqual(readdirSync(f.root).sort(), ["captured", "source"]);
      } finally {
        if (prior === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = prior;
        f.cleanup();
      }
    },
  );
}
