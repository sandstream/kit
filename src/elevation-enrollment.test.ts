import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { it } from "node:test";
import { createCliContractFixture } from "./cli-contract.test-support.js";

type Fixture = ReturnType<typeof createCliContractFixture>;

interface EnrollmentResult {
  phase: "enrolled";
  success: boolean;
  selfVerified: boolean;
}

interface VerificationResult {
  phase: "verified";
  matchesResolvedSecret: boolean;
  returnedCodeVerified: boolean;
  freshCodeVerified: boolean;
}

function enrollmentWorkerScript(overwrite: boolean): string {
  const source = import.meta.url.endsWith(".ts");
  const api = new URL(source ? "./elevation.ts" : "./elevation.js", import.meta.url);
  return `
    import { once } from "node:events";
    import { enrollTotp, resolveTotpSecret, generateTotp, verifyTotp } from ${JSON.stringify(api.href)};
    let enrollment;
    const receive = async (expected) => {
      const [message] = await once(process, "message");
      if (message !== expected) throw new Error("Unexpected enrollment test message");
    };
    // Both processes finish source imports before the parent releases the barrier.
    process.send({ phase: "ready" });
    await receive("enroll");
    try {
      enrollment = await enrollTotp({ accountName: "disposable-test", overwrite: ${overwrite} });
    } catch {
      // Refusal is an expected API result for the competing enrollment.
    }
    process.send({
      phase: "enrolled",
      success: Boolean(enrollment),
      selfVerified: Boolean(enrollment && verifyTotp(enrollment.currentCode, enrollment.secret)),
    });
    await receive("verify");
    const finalSecret = await resolveTotpSecret();
    process.send({
      phase: "verified",
      matchesResolvedSecret: Boolean(enrollment && finalSecret === enrollment.secret),
      returnedCodeVerified: Boolean(enrollment && finalSecret && verifyTotp(enrollment.currentCode, finalSecret)),
      freshCodeVerified: Boolean(enrollment && finalSecret && verifyTotp(generateTotp(enrollment.secret), finalSecret)),
    });
    process.disconnect();
  `;
}

function startEnrollmentWorker(fixture: Fixture, overwrite: boolean) {
  const source = import.meta.url.endsWith(".ts");
  const loader = source ? ["--import", import.meta.resolve("tsx")] : [];
  const script = enrollmentWorkerScript(overwrite);
  const child = spawn(process.execPath, [...loader, "--input-type=module", "-e", script], {
    cwd: fixture.cwd,
    env: fixture.env,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let output = "";
  let spawnError: Error | undefined;
  assert.ok(child.stdout);
  assert.ok(child.stderr);
  child.stdout.on("data", (chunk) => (output += chunk.toString()));
  child.stderr.on("data", (chunk) => (output += chunk.toString()));
  child.on("error", (error) => (spawnError = error));
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const nextMessage = () => once(child, "message", { signal: AbortSignal.timeout(15_000) });
  const ready = nextMessage();
  // Observe a readiness failure immediately, even if another worker is still starting.
  void ready.catch(() => {});
  return {
    ready: async () => {
      const [message] = await ready;
      assert.equal(message.phase, "ready");
    },
    enroll: async (): Promise<EnrollmentResult> => {
      const pending = nextMessage();
      child.send("enroll");
      const [message] = await pending;
      assert.equal(message.phase, "enrolled");
      return message;
    },
    verify: async (): Promise<VerificationResult> => {
      const pending = nextMessage();
      child.send("verify");
      const [message] = await pending;
      assert.equal(message.phase, "verified");
      const result = await closed;
      assert.ifError(spawnError);
      assert.equal(result.code, 0, output);
      assert.equal(result.signal, null, output);
      assert.equal(output, "", "enrollment must not emit unrelated runtime diagnostics");
      return message;
    },
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await closed;
    },
  };
}

async function enrollPair(sequential: boolean, overwriteSecond = false) {
  const fixture = createCliContractFixture();
  const workers: ReturnType<typeof startEnrollmentWorker>[] = [];
  try {
    workers.push(startEnrollmentWorker(fixture, false));
    workers.push(startEnrollmentWorker(fixture, overwriteSecond));
    await Promise.all(workers.map((worker) => worker.ready()));
    const enrolled = sequential
      ? [await workers[0].enroll(), await workers[1].enroll()]
      : await Promise.all(workers.map((worker) => worker.enroll()));
    // Keep returned credentials inside their workers until both writes have finished.
    const verified = await Promise.all(workers.map((worker) => worker.verify()));
    return { enrolled, verified };
  } finally {
    await Promise.all(workers.map((worker) => worker.stop()));
    fixture.cleanup();
  }
}

function assertUsableCredential(result: VerificationResult): void {
  assert.equal(
    result.matchesResolvedSecret,
    true,
    "returned credential must match the final secret",
  );
  assert.equal(
    result.returnedCodeVerified,
    true,
    "returned TOTP must verify against the final secret",
  );
  assert.equal(result.freshCodeVerified, true, "fresh TOTP must verify against the final secret");
}

it("concurrent TOTP enrollment returns one successful, usable credential without overwrite", async () => {
  // Repeat fresh two-process races without changing the filesystem or API timing.
  for (let attempt = 0; attempt < 5; attempt++) {
    const { enrolled, verified } = await enrollPair(false);
    const successes = enrolled.filter((result) => result.success);
    assert.equal(
      successes.length,
      1,
      "only one competing enrollment may succeed without overwrite",
    );
    assert.equal(successes[0].selfVerified, true);
    assert.equal(verified.filter((result) => result.matchesResolvedSecret).length, 1);
    assertUsableCredential(verified[enrolled.findIndex((result) => result.success)]);
  }
});

it("sequential TOTP enrollment refuses replacement and retains the first usable credential", async () => {
  const { enrolled, verified } = await enrollPair(true);
  assert.deepEqual(
    enrolled.map((result) => result.success),
    [true, false],
  );
  assert.equal(enrolled[0].selfVerified, true);
  assertUsableCredential(verified[0]);
  assert.equal(verified[1].matchesResolvedSecret, false);
});

it("explicit TOTP overwrite replaces the first enrollment with a usable credential", async () => {
  const { enrolled, verified } = await enrollPair(true, true);
  assert.deepEqual(
    enrolled.map((result) => result.success),
    [true, true],
  );
  assert.equal(
    enrolled.every((result) => result.selfVerified),
    true,
  );
  assert.equal(verified[0].matchesResolvedSecret, false);
  assertUsableCredential(verified[1]);
});
