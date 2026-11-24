import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { signState, storeFixture } from "./authority-store.test-support.js";
import { captureIncomingCandidate, type IncomingCandidateFlow } from "./candidate-flow.js";
import { prepareLaunchPolicy } from "./launch-policy.js";
import type { ExpectedNpmArtifact } from "./runtime-npm-policy.js";

/** Native disk setup is timed separately from the signed workload deadline. */
export const NATIVE_RUN_TEST_WINDOW_MS = 120_000;

export async function launchFixture(
  script: (paths: { authority: string; sentinel: string }) => string,
  timeoutMs = 5000,
  populate?: (repository: string) => void,
  capture?: (source: string, destination: string) => Promise<IncomingCandidateFlow>,
  npmArtifacts?: ExpectedNpmArtifact[],
) {
  const fixture = storeFixture();
  try {
    const { directory, repository, store, proof, root } = fixture;
    const authority = join(directory, "authority.sqlite");
    const sentinel = join(root, "secret");
    writeFileSync(sentinel, "synthetic secret");
    const manifest = { name: "run-fixture", version: "1.0.0", type: "module" };
    writeFileSync(join(repository, "package.json"), JSON.stringify(manifest));
    writeFileSync(
      join(repository, "package-lock.json"),
      JSON.stringify({
        ...manifest,
        lockfileVersion: 3,
        packages: { "": manifest },
      }),
    );
    writeFileSync(join(repository, "main.mjs"), script({ authority, sentinel }));
    populate?.(repository);
    const source = join(root, "sealed-source");
    const captured = await (capture?.(repository, source) ??
      captureIncomingCandidate({
        source: repository,
        destination: source,
        fetchPolicy: { origins: [] },
      }));
    if (captured.status !== "bound") assert.fail(captured.reason);
    const policy = {
      schema: 1,
      entry: "main.mjs",
      outputDirectory: join(root, "results"),
      timeoutMs,
      ...(npmArtifacts ? { npmArtifacts } : {}),
    };
    const prepared = prepareLaunchPolicy(policy);
    if (!prepared.ok) assert.fail(prepared.reason);
    proof.authority.policyDigest = prepared.policyDigest;
    proof.authority.maxVerificationAgeMs = NATIVE_RUN_TEST_WINDOW_MS;
    proof.authority.maxApprovalAgeMs = NATIVE_RUN_TEST_WINDOW_MS;
    store.update(repository, { type: "enroll", authority: proof.authority });
    const pending = store.update(repository, {
      type: "stage",
      expectedPhase: "pending",
      expectedGeneration: 1,
      candidateDigest: captured.candidate.candidateDigest,
      evidence: captured.candidate.checks,
    });
    const now = Date.now();
    proof.now = now;
    proof.verification.createdAt = now;
    proof.approval.issuedAt = now;
    proof.approval.expiresAt = now + NATIVE_RUN_TEST_WINDOW_MS;
    proof.verification.checks.push(...captured.candidate.checks);
    const signed = signState(fixture, pending);
    store.update(repository, signed);
    return { ...fixture, source, policy, prepared, verification: signed.verification };
  } catch (error) {
    fixture.cleanup();
    throw error;
  }
}
