/** Preserve review evidence if an interrupted worktree is moved. */
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { getAuditAnchorKey } from "./audit-anchor.js";
import { captureChildStderr, requireChildExit } from "./review-child-process.test-support.js";
import { readHistory } from "./review-receipt-history-io.js";
import { verifyReviewReceipt, type SignedReviewReceipt } from "./review-receipt.js";

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

it("preserves pending evidence after a worktree rename and recovers at the original path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kit-moved-review-"));
  const repo = join(dir, "repo"),
    moved = join(dir, "moved"),
    signals = join(dir, "signals");
  const anchor = join(dir, "anchor"),
    env = { ...process.env, KIT_AUDIT_ANCHOR_DIR: anchor };
  mkdirSync(repo);
  mkdirSync(signals);
  try {
    execFileSync("git", ["init", "-q"], { cwd: repo });
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
      { cwd: repo },
    );
    const root = resolve(
      execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: repo, encoding: "utf8" }).trim(),
    );
    await stopAfterGate(root, signals, env);
    const pendingPath = join(".git", "kit-review-receipt.lock", "pending.json");
    const pending = readFileSync(join(repo, pendingPath));
    const signed = JSON.parse(pending.toString("utf8")) as SignedReviewReceipt;
    const key = await getAuditAnchorKey(anchor);
    assert.equal(verifyReviewReceipt(signed, key, signed.head).ok, true);
    renameSync(repo, moved);
    const recover = (cwd: string) =>
      requireChildExit(
        spawnSync(process.execPath, [fixture, cwd, "recover", signals], {
          env,
          encoding: "utf8",
          timeout: 60000,
        }),
        "recovery",
      );
    const denied = recover(moved);
    assert.notEqual(denied.status, 0);
    assert.match(denied.stderr, /review owner is missing or invalid/i);
    assert.equal(readFileSync(join(moved, pendingPath)).equals(pending), true);
    assert.equal(existsSync(join(moved, ".git", "kit-review-receipt.lock")), true);
    renameSync(moved, repo);
    const restored = recover(repo);
    assert.equal(restored.status, 0, restored.stderr);
    assert.equal(existsSync(join(repo, pendingPath)), false);
    assert.deepEqual(
      readHistory(root, key).map((entry) => entry.signature),
      [signed.signature],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
