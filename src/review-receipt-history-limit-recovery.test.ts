/** Preserve signed review evidence when history reaches its byte limit. */
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { getAuditAnchorKey } from "./audit-anchor.js";
import { captureChildStderr, requireChildExit } from "./review-child-process.test-support.js";
import { MAX_RECEIPT_BYTES } from "./review-receipt-files.js";
import { readHistory } from "./review-receipt-history-io.js";
import {
  signReviewReceipt,
  verifyReviewReceipt,
  type SignedReviewReceipt,
} from "./review-receipt.js";

const fixture = fileURLToPath(new URL("./review-receipt-process.test-support.js", import.meta.url));

async function stopAfterGate(root: string, signals: string, env: NodeJS.ProcessEnv): Promise<void> {
  const child = spawn(process.execPath, [fixture, root, "crash-gate", signals], {
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  const stderr = captureChildStderr(child);
  try {
    const deadline = Date.now() + 30000;
    while (!existsSync(join(signals, "crash-gate.barrier"))) {
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(`fixture exited early\n${stderr()}`);
      if (Date.now() > deadline) throw new Error(`fixture timed out\n${stderr()}`);
      await new Promise((done) => setTimeout(done, 20));
    }
    const exited = new Promise<void>((done) => child.once("exit", () => done()));
    child.kill("SIGKILL");
    await exited;
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}

it("keeps signed pending evidence and the lock when recovery exceeds the history limit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kit-history-limit-recovery-"));
  const root = join(dir, "repo"),
    signals = join(dir, "signals"),
    anchor = join(dir, "anchor");
  mkdirSync(root);
  mkdirSync(signals);
  const env = { ...process.env, KIT_AUDIT_ANCHOR_DIR: anchor };
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.test",
        "commit",
        "--allow-empty",
        "-qm",
        "test",
      ],
      { cwd: root },
    );
    const gitRoot = resolve(
      execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf8" }).trim(),
    );
    await stopAfterGate(gitRoot, signals, env);
    const lock = join(gitRoot, ".git", "kit-review-receipt.lock");
    const pendingPath = join(lock, "pending.json");
    const pending = readFileSync(pendingPath);
    const signed = JSON.parse(pending.toString("utf8")) as SignedReviewReceipt;
    const key = await getAuditAnchorKey(anchor);
    assert.equal(verifyReviewReceipt(signed, key, signed.head).ok, true);
    const { signature: _signature, sig_alg: _algorithm, ...body } = signed;
    const makeHistory = (padding: string) =>
      signReviewReceipt(
        { ...body, run_id: "a".repeat(32), gate: { ...body.gate, failures: [padding] } },
        key,
      );
    const baseBytes = Buffer.byteLength(JSON.stringify(makeHistory("")) + "\n");
    const historyPath = join(gitRoot, ".kit-review-receipt-history.jsonl");
    writeFileSync(
      historyPath,
      JSON.stringify(makeHistory("x".repeat(MAX_RECEIPT_BYTES - baseBytes - 1))) + "\n",
    );
    const history = readFileSync(historyPath);
    assert.equal(history.length, MAX_RECEIPT_BYTES - 1);
    const recovery = requireChildExit(
      spawnSync(process.execPath, [fixture, gitRoot, "recover", signals], {
        env,
        encoding: "utf8",
        timeout: 60000,
      }),
      "recovery",
    );
    assert.notEqual(recovery.status, 0);
    assert.match(recovery.stderr, /history.*size limit/i);
    assert.equal(readFileSync(historyPath).equals(history), true);
    assert.equal(readFileSync(pendingPath).equals(pending), true);
    assert.equal(existsSync(lock), true);
    assert.equal(readHistory(gitRoot, key).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
