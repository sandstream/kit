import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import { signState, storeFixture } from "./authority-store.test-support.js";
import { captureIncomingCandidate } from "./candidate-flow.js";
import { acceptCandidate, stageCandidate } from "./lifecycle.js";

async function retainedFixture() {
  const fixture = storeFixture();
  try {
    const { root, repository, store, proof } = fixture;
    const manifest = { name: "sample", version: "1.0.0" };
    writeFileSync(join(repository, "package.json"), JSON.stringify(manifest));
    writeFileSync(
      join(repository, "package-lock.json"),
      JSON.stringify({
        ...manifest,
        lockfileVersion: 3,
        packages: { "": manifest },
      }),
    );
    const destination = join(root, "snapshot");
    const result = await captureIncomingCandidate({
      source: repository,
      destination,
      fetchPolicy: { origins: [] },
    });
    if (result.status !== "bound") assert.fail(result.reason);
    store.update(repository, { type: "enroll", authority: proof.authority });
    const state = stageCandidate(
      store,
      repository,
      result.candidate.candidateDigest,
      result.candidate.checks,
    );
    const now = Date.now();
    proof.now = now;
    proof.verification.createdAt = now;
    proof.approval.issuedAt = now;
    proof.approval.expiresAt = now + 30_000;
    proof.verification.checks.push(...result.candidate.checks);
    const signed = signState(fixture, state);
    acceptCandidate(store, repository, signed.verification, signed.approval, now);
    return { ...fixture, destination, verification: signed.verification };
  } catch (error) {
    fixture.cleanup();
    throw error;
  }
}

it("checks retained files against exactly the approved repository, generation and policy", async () => {
  const f = await retainedFixture();
  try {
    const verify = (report = f.verification) =>
      f.store.preflight(f.repository, f.destination, report);
    assert.deepEqual(verify(), { verified: true });
    const changes = [
      { repositoryId: "other-repo" },
      { generation: f.verification.context.generation + 1 },
      { policyDigest: "a".repeat(64) },
    ];
    for (const change of changes) {
      assert.deepEqual(
        verify({
          ...f.verification,
          context: { ...f.verification.context, ...change },
        }),
        { verified: false, reason: "verification-mismatch" },
      );
    }
    writeFileSync(join(f.destination, "tree", "package.json"), "{}");
    assert.deepEqual(verify(), { verified: false, reason: "snapshot-changed" });
  } finally {
    f.cleanup();
  }
});

it("rechecks approval freshness after reading the retained inputs", async (t) => {
  const f = await retainedFixture();
  try {
    const times = [f.proof.now, f.proof.approval.expiresAt + 1];
    t.mock.method(Date, "now", () => times.shift() ?? f.proof.approval.expiresAt + 1);
    assert.deepEqual(f.store.preflight(f.repository, f.destination, f.verification), {
      verified: false,
      reason: "stale-approval",
    });
    assert.deepEqual(times, []);
  } finally {
    f.cleanup();
  }
});

function startWaitingPreflight(f: Awaited<ReturnType<typeof retainedFixture>>) {
  const worker = join(f.root, "waiting-preflight.mjs");
  const report = join(f.root, "report.json");
  writeFileSync(report, JSON.stringify(f.verification));
  writeFileSync(
    worker,
    `
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { IncomingTrustStore } from ${JSON.stringify(new URL("./authority-store.js", import.meta.url).href)};
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function (statement) {
  if (statement === "BEGIN IMMEDIATE") process.send("acquiring");
  return exec.call(this, statement);
};
const [directory, repository, destination, report] = process.argv.slice(2);
const result = new IncomingTrustStore(directory).preflight(repository, destination, JSON.parse(readFileSync(report)));
process.send(result);
process.disconnect();
`,
  );
  return fork(worker, [f.directory, f.repository, f.destination, report], {
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
}

type RetainedFixture = Awaited<ReturnType<typeof retainedFixture>>;
const mutations: { name: string; change: (f: RetainedFixture) => void; reason: string }[] = [
  {
    name: "retained input",
    change: (f) => writeFileSync(join(f.destination, "tree", "package.json"), "{}"),
    reason: "snapshot-changed",
  },
  {
    name: "repository directory",
    change: (f) => {
      renameSync(f.repository, join(f.root, "original"));
      mkdirSync(f.repository);
    },
    reason: "state-unavailable",
  },
];

for (const { name, change, reason } of mutations) {
  it(`refuses a changed ${name} while another process holds the generation lock`, async () => {
    const f = await retainedFixture();
    const db = new DatabaseSync(join(f.directory, "authority.sqlite"));
    let child: ReturnType<typeof fork> | undefined;
    try {
      // Use the same bounded wait as the authority store while the other connection opens.
      db.exec("PRAGMA busy_timeout = 5000");
      db.exec("BEGIN IMMEDIATE");
      child = startWaitingPreflight(f);
      const exit = once(child, "exit");
      const signal = AbortSignal.timeout(15_000);
      const [acquiring] = await once(child, "message", { signal });
      assert.equal(acquiring, "acquiring");
      const result = once(child, "message", { signal });
      change(f);
      db.exec("COMMIT");
      const [decision] = await result;
      assert.deepEqual(decision, { verified: false, reason });
      assert.deepEqual(await exit, [0, null]);
    } finally {
      db.close();
      if (child && child.exitCode === null && child.signalCode === null) {
        const stopped = once(child, "exit");
        child.kill();
        await stopped;
      }
      f.cleanup();
    }
  });
}
