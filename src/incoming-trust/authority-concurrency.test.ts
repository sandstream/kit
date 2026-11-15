import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { it } from "node:test";
import { assertSqliteDiagnostics, storeFixture } from "./authority-store.test-support.js";

const execute = promisify(execFile);

it("serializes two real processes and refuses the writer with a stale generation", async () => {
  const f = storeFixture();
  try {
    f.store.update(f.repository, { type: "enroll", authority: f.proof.authority });
    const worker = join(f.root, "writer.mjs");
    writeFileSync(
      worker,
      `import { IncomingTrustStore } from ${JSON.stringify(new URL("./authority-store.js", import.meta.url).href)};
const [directory, repository, digest] = process.argv.slice(2);
try {
  const state = new IncomingTrustStore(directory).update(repository, { type: 'stage', evidence: [], expectedGeneration: 1, expectedPhase: "pending", candidateDigest: digest });
  process.stdout.write(JSON.stringify({ accepted: true, digest: state.candidateDigest }));
} catch (error) {
  process.stdout.write(JSON.stringify({ accepted: false, reason: error.message }));
}
`,
    );
    const runs = await Promise.all(
      ["c", "f"].map((letter) =>
        execute(
          process.execPath,
          ["--import", "tsx", worker, f.directory, f.repository, letter.repeat(64)],
          { encoding: "utf8", timeout: 30_000 },
        ),
      ),
    );
    const results = runs.map(({ stdout, stderr }) => {
      assertSqliteDiagnostics(stderr);
      return JSON.parse(stdout) as { accepted: boolean; digest?: string; reason?: string };
    });
    assert.equal(results.filter((r) => r.accepted).length, 1);
    assert.deepEqual(
      results.filter((r) => !r.accepted),
      [{ accepted: false, reason: "Incoming trust: stale-generation" }],
    );
    const persisted = f.store.read(f.repository);
    assert.equal(persisted?.authority.generation, 2);
    assert.equal(persisted?.candidateDigest, results.find((r) => r.accepted)?.digest);
  } finally {
    f.cleanup();
  }
});
