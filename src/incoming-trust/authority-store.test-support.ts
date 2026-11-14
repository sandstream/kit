import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IncomingTrustStore } from "./authority-store.js";
import type { IncomingTrustState } from "./authority-store.js";
import { decisionFixture } from "./decision.test-support.js";
import { rmTemp } from "../temp-cleanup.test-support.js";
import { secureDirStrict } from "../utils/secure-perms.js";

export function assertSqliteDiagnostics(stderr: string): void {
  // Node 22 emits this expected diagnostic when the real SQLite module loads.
  assert.match(
    stderr,
    /^(?:\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\r?\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\r?\n)?$/,
  );
}

export function storeFixture() {
  const root = mkdtempSync(join(tmpdir(), "kit-incoming-authority-"));
  try {
    secureDirStrict(root);
    const repository = join(root, "repository");
    mkdirSync(repository);
    const directory = join(root, "authority");
    const store = new IncomingTrustStore(directory);
    const proof = decisionFixture();
    proof.authority.generation = 1;
    return { root, repository, directory, store, proof, cleanup: () => rmTemp(root) };
  } catch (error) {
    rmTemp(root);
    throw error;
  }
}

export function signState(f: ReturnType<typeof storeFixture>, state: IncomingTrustState) {
  const { repositoryId, baselineDigest, policyDigest, generation } = state.authority;
  const context = {
    schema: 1 as const,
    repositoryId,
    baselineDigest,
    policyDigest,
    generation,
    candidateDigest: state.candidateDigest!,
  };
  f.proof.context = context;
  f.proof.verification.context = { ...context };
  f.proof.approval.context = { ...context };
  f.proof.resign();
  return {
    type: "accept" as const,
    expectedGeneration: generation,
    expectedPhase: state.phase,
    verification: f.proof.verification,
    approval: f.proof.approval,
    now: f.proof.now,
  };
}
