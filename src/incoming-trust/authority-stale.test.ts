import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import {
  assertSqliteDiagnostics,
  signState,
  storeFixture,
} from "./authority-store.test-support.js";

it("refuses a stale process after another writer accepts the same candidate generation", async () => {
  const f = storeFixture();
  let child: ReturnType<typeof fork> | undefined;
  try {
    f.store.update(f.repository, { type: "enroll", authority: f.proof.authority });
    const staged = f.store.update(f.repository, {
      type: "stage",
      expectedGeneration: 1,
      expectedPhase: "pending",
      candidateDigest: "c".repeat(64),
    });
    const worker = join(f.root, "stale-writer.mjs");
    writeFileSync(
      worker,
      `import { IncomingTrustStore } from ${JSON.stringify(new URL("./authority-store.js", import.meta.url).href)};
const [directory, repository] = process.argv.slice(2);
const store = new IncomingTrustStore(directory);
const snapshot = store.read(repository);
process.once('message', () => {
  try {
    store.update(repository, { type: 'reject', expectedGeneration: snapshot.authority.generation, expectedPhase: snapshot.phase });
    process.send({ refused: false });
  } catch (error) {
    process.send({ refused: true, reason: error.message });
  }
  process.disconnect();
});
process.send({ phase: snapshot.phase, generation: snapshot.authority.generation });
`,
    );
    child = fork(worker, [f.directory, f.repository], {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let diagnostics = "";
    child.stderr!.on("data", (chunk: Buffer) => {
      diagnostics += chunk.toString();
    });
    const completion = once(child, "exit");
    const signal = AbortSignal.timeout(30_000);
    const [ready] = await once(child, "message", { signal });
    assert.deepEqual(ready, { phase: "pending", generation: 2 });
    const accepted = f.store.update(f.repository, signState(f, staged));
    const response = once(child, "message", { signal });
    child.send("continue");
    const [result] = await response;
    assert.deepEqual(await completion, [0, null]);
    assertSqliteDiagnostics(diagnostics);
    assert.deepEqual(result, { refused: true, reason: "Incoming trust: stale-state" });
    assert.deepEqual(f.store.read(f.repository), accepted);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, "exit");
      child.kill();
      await stopped;
    }
    f.cleanup();
  }
});
