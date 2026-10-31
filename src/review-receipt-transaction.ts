/** Coordinate review receipt writers across processes in one Git worktree. */
import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ReadCommand } from "./review-receipt-io.js";
import { openReceiptForRead } from "./review-receipt-files.js";

const LOCK_NAME = "kit-review-receipt.lock";
const GENERATION_NAME = "kit-review-receipt-generation";
const RUN_ID = /^[a-f0-9]{32}$/;

export interface ReviewTransaction {
  root: string;
  dir: string;
  runId: string;
  pid: number;
  host: string;
}

export interface RecoveryClaim {
  dir: string;
  id: string;
  pid: number;
  host: string;
}

function gitDirectory(root: string, run: ReadCommand): string {
  const value = run("git", ["rev-parse", "--absolute-git-dir"], root).trim();
  if (!value) throw new Error("review Git directory is unavailable");
  return resolve(root, value);
}

function lockPath(root: string, run: ReadCommand): string {
  return join(gitDirectory(root, run), LOCK_NAME);
}

function assertAbsent(path: string): void {
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(
    "a review is running or incomplete; wait and retry, or inspect it and run kit review recover-receipt --confirm-stopped",
  );
}

export function reviewReadStamp(root: string, run: ReadCommand): string | null {
  const gitDir = gitDirectory(root, run);
  const lock = join(gitDir, LOCK_NAME);
  assertAbsent(lock);
  const value = readOptionalFile(join(gitDir, GENERATION_NAME), 32);
  if (value !== null && !RUN_ID.test(value)) throw new Error("invalid review generation marker");
  assertAbsent(lock);
  return value;
}

export function assertReviewReadStamp(
  root: string,
  run: ReadCommand,
  expected: string | null,
): void {
  if (reviewReadStamp(root, run) !== expected) {
    throw new Error("review evidence changed while reading; retry the operation");
  }
}

function writeExclusive(path: string, content: string): void {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, content, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function readOptionalFile(path: string, maxBytes = 16 * 1024 * 1024): string | null {
  let entry;
  try {
    entry = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!entry.isFile() || entry.nlink !== 1) throw new Error("invalid review transaction file");
  const fd = openReceiptForRead(path);
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= maxBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) return Buffer.concat(chunks, total).toString("utf8");
      total += count;
      if (total > maxBytes) throw new Error("review transaction file is too large");
      chunks.push(chunk.subarray(0, count));
    }
    throw new Error("review transaction file is too large");
  } finally {
    closeSync(fd);
  }
}

export function beginReviewTransaction(
  root: string,
  run: ReadCommand,
  afterLockCreated?: () => void,
): ReviewTransaction {
  const dir = lockPath(root, run);
  const runId = randomBytes(16).toString("hex");
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        "a review is running or incomplete; wait and retry, or inspect it and run kit review recover-receipt --confirm-stopped",
        { cause: error },
      );
    }
    throw error;
  }
  afterLockCreated?.();
  const transaction = { root, dir, runId, pid: process.pid, host: hostname() };
  writeExclusive(join(dir, "owner.json"), JSON.stringify(transaction));
  const temp = join(dir, "generation");
  writeExclusive(temp, runId);
  renameSync(temp, join(gitDirectory(root, run), GENERATION_NAME));
  return transaction;
}

function assertTransactionMetadata(transaction: ReviewTransaction): void {
  const content = readOptionalFile(join(transaction.dir, "owner.json"), 4096);
  if (content === null)
    throw new Error(
      `review transaction owner is missing at ${join(transaction.dir, "owner.json")}; inspect the lock manually`,
    );
  const actual = JSON.parse(content) as ReviewTransaction;
  if (
    actual.root !== transaction.root ||
    actual.dir !== transaction.dir ||
    actual.runId !== transaction.runId ||
    actual.pid !== transaction.pid ||
    actual.host !== transaction.host
  )
    throw new Error("review transaction owner changed");
}

export function assertReviewOwner(transaction: ReviewTransaction): void {
  assertTransactionMetadata(transaction);
  if (transaction.pid !== process.pid || transaction.host !== hostname()) {
    throw new Error("review transaction belongs to another process");
  }
}

export function writeReviewPending(transaction: ReviewTransaction, content: string): void {
  assertReviewOwner(transaction);
  const temp = join(transaction.dir, `pending-${randomBytes(8).toString("hex")}`);
  writeExclusive(temp, content);
  renameSync(temp, join(transaction.dir, "pending.json"));
}

export function markReviewStarted(transaction: ReviewTransaction): void {
  assertReviewOwner(transaction);
  writeExclusive(join(transaction.dir, "started"), transaction.runId);
}

export function reviewStarted(transaction: ReviewTransaction): boolean {
  const value = readOptionalFile(join(transaction.dir, "started"));
  if (value === null) return false;
  if (value !== transaction.runId) throw new Error("invalid review start marker");
  return true;
}

export function readReviewPending(transaction: ReviewTransaction): string | null {
  return readOptionalFile(join(transaction.dir, "pending.json"));
}

export function readReviewStagedPending(
  transaction: ReviewTransaction,
): { name: string; content: string }[] {
  const names = readdirSync(transaction.dir).filter((name) => /^pending-[a-f0-9]{16}$/.test(name));
  return names.map((name) => {
    const content = readOptionalFile(join(transaction.dir, name));
    if (content === null) throw new Error("staged review evidence disappeared");
    return { name, content };
  });
}

export function claimReviewRecovery(transaction: ReviewTransaction): RecoveryClaim {
  assertTransactionMetadata(transaction);
  const dir = join(transaction.dir, "recovery");
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        `a recovery is running or incomplete; inspect ${join(dir, "owner.json")} and confirm its owner stopped before removing the claim`,
        { cause: error },
      );
    }
    throw error;
  }
  const claim = { dir, id: randomBytes(16).toString("hex"), pid: process.pid, host: hostname() };
  writeExclusive(join(dir, "owner.json"), JSON.stringify(claim));
  return claim;
}

function assertRecoveryOwner(claim: RecoveryClaim): void {
  const content = readOptionalFile(join(claim.dir, "owner.json"), 4096);
  if (content === null) throw new Error("review recovery owner is missing");
  const actual = JSON.parse(content) as RecoveryClaim;
  if (
    actual.id !== claim.id ||
    actual.pid !== claim.pid ||
    actual.host !== claim.host ||
    claim.pid !== process.pid ||
    claim.host !== hostname()
  ) {
    throw new Error("review recovery owner changed");
  }
}

export function releaseReviewRecovery(claim: RecoveryClaim): void {
  assertRecoveryOwner(claim);
  unlinkSync(join(claim.dir, "owner.json"));
  rmdirSync(claim.dir);
}

export function finishReviewTransaction(
  transaction: ReviewTransaction,
  claim?: RecoveryClaim,
  verifiedStaged: { name: string; content: string }[] = [],
  expectedPending: string | null = null,
  expectedStarted = false,
): void {
  if (claim) {
    assertTransactionMetadata(transaction);
    assertRecoveryOwner(claim);
  } else {
    assertReviewOwner(transaction);
  }
  if (
    readReviewPending(transaction) !== expectedPending ||
    reviewStarted(transaction) !== expectedStarted
  ) {
    throw new Error("review transaction evidence changed before completion");
  }
  const allowed = new Set([
    "owner.json",
    "pending.json",
    "started",
    ...(claim ? ["recovery"] : []),
  ]);
  const staged = readdirSync(transaction.dir).filter((name) => {
    if (allowed.has(name)) return false;
    const verified = verifiedStaged.find((item) => item.name === name);
    if (!/^pending-[a-f0-9]{16}$/.test(name) || !verified) {
      throw new Error("unexpected file in review transaction; inspect manually");
    }
    if (readOptionalFile(join(transaction.dir, name)) !== verified.content) {
      throw new Error("staged review evidence changed");
    }
    return true;
  });
  if (verifiedStaged.some((item) => !staged.includes(item.name))) {
    throw new Error("verified staged review evidence disappeared");
  }
  const completed = join(dirname(transaction.dir), `kit-review-complete-${transaction.runId}`);
  renameSync(transaction.dir, completed);
  for (const name of staged) unlinkSync(join(completed, name));
  if (claim) {
    unlinkSync(join(completed, "recovery", "owner.json"));
    rmdirSync(join(completed, "recovery"));
  }
  const pending = join(completed, "pending.json");
  if (existsSync(pending)) unlinkSync(pending);
  const started = join(completed, "started");
  if (existsSync(started)) unlinkSync(started);
  unlinkSync(join(completed, "owner.json"));
  rmdirSync(completed);
}

export function loadReviewTransaction(root: string, run: ReadCommand): ReviewTransaction {
  const dir = lockPath(root, run);
  if (!lstatSync(dir).isDirectory()) throw new Error("invalid review transaction directory");
  const ownerPath = join(dir, "owner.json");
  const guidance = `Review owner is missing or invalid at ${ownerPath}. Preserve ${dir}, confirm no review or recovery process is running, and inspect every pending and staged file before any manual cleanup.`;
  let transaction: ReviewTransaction;
  try {
    const content = readOptionalFile(ownerPath, 4096);
    if (content === null) throw new Error("owner is missing");
    transaction = JSON.parse(content) as ReviewTransaction;
  } catch (error) {
    throw new Error(guidance, { cause: error });
  }
  if (
    !transaction ||
    typeof transaction !== "object" ||
    transaction.root !== root ||
    transaction.dir !== dir ||
    !RUN_ID.test(transaction.runId) ||
    !Number.isSafeInteger(transaction.pid) ||
    transaction.pid < 1 ||
    !transaction.host
  )
    throw new Error(guidance);
  return transaction;
}
