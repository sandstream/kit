/** Check receipt writes when read-only mode changes during a transaction. */
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { rmTemp } from "./temp-cleanup.test-support.js";
import {
  captureReviewSnapshot,
  prepareReviewReceipt,
  recordReviewGate,
  recoverReviewReceipt,
  writeReviewReceipt,
  type ReadCommand,
} from "./review-receipt-io.js";
import { beginReviewTransaction } from "./review-receipt-transaction.js";

const gate = { command: "kit review --receipt", exitCode: 1, stdout: "failed", stderr: "" };
const isSource = import.meta.url.endsWith(".ts");
const childFixture = fileURLToPath(
  new URL(`./review-receipt-process.test-support.${isSource ? "ts" : "js"}`, import.meta.url),
);

function graph(args: string[], head: string): string {
  const query = args.find((value) => value.startsWith("query=")) ?? "";
  if (query.includes("baseRefName baseRef")) {
    return JSON.stringify({
      data: {
        repository: {
          defaultBranchRef: { name: "main", target: { oid: head } },
          pullRequest: {
            number: 12,
            headRefOid: head,
            baseRefName: "main",
            baseRef: { target: { oid: head } },
          },
        },
      },
    });
  }
  if (query.includes("baseCommit:object")) {
    return JSON.stringify({
      data: {
        repository: {
          baseCommit: { oid: head },
          headCommit: { oid: head },
          defaultCommit: { oid: head },
          baseFile: null,
          headFile: null,
          defaultFile: null,
        },
      },
    });
  }
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: { totalCount: 0, pageInfo: { hasNextPage: false }, nodes: [] },
        },
      },
    },
  });
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "kit-review-readonly-"));
  const root = join(dir, "repo");
  const anchor = join(dir, "anchor");
  const signals = join(dir, "signals");
  mkdirSync(root);
  mkdirSync(signals);
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.test",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-qm",
      "fixture",
    ],
    { cwd: root },
  );
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const run: ReadCommand = (command, args, cwd) => {
    if (command === "git") return execFileSync(command, args, { cwd, encoding: "utf8" });
    if (args[0] === "repo") return '{"nameWithOwner":"sandstream/kit"}';
    if (args[0] === "pr")
      return JSON.stringify({
        number: 12,
        headRefOid: head,
        changedFiles: 0,
        files: [],
        statusCheckRollup: [],
      });
    if (args.includes("graphql")) return graph(args, head);
    if (args.includes("--paginate")) return "[[]]";
    if (args.includes("--jq")) return head;
    throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
  };
  return { dir, root, anchor, signals, run };
}

async function withFixture(
  test: (value: ReturnType<typeof setup>) => Promise<void>,
): Promise<void> {
  const fixture = setup();
  const priorReadOnly = process.env.KIT_READ_ONLY;
  const priorAnchor = process.env.KIT_AUDIT_ANCHOR_DIR;
  const priorAuditAnchor = process.env.KIT_AUDIT_ANCHOR;
  delete process.env.KIT_READ_ONLY;
  process.env.KIT_AUDIT_ANCHOR_DIR = fixture.anchor;
  process.env.KIT_AUDIT_ANCHOR = "0";
  try {
    await test(fixture);
  } finally {
    if (priorReadOnly === undefined) delete process.env.KIT_READ_ONLY;
    else process.env.KIT_READ_ONLY = priorReadOnly;
    if (priorAnchor === undefined) delete process.env.KIT_AUDIT_ANCHOR_DIR;
    else process.env.KIT_AUDIT_ANCHOR_DIR = priorAnchor;
    if (priorAuditAnchor === undefined) delete process.env.KIT_AUDIT_ANCHOR;
    else process.env.KIT_AUDIT_ANCHOR = priorAuditAnchor;
    rmTemp(fixture.dir);
  }
}

function paths(root: string, transactionDir: string, anchor: string) {
  return {
    pending: join(transactionDir, "pending.json"),
    history: join(root, ".kit-review-receipt-history.jsonl"),
    receipt: join(root, ".kit-review-receipt.json"),
    key: join(anchor, "audit-anchor.key"),
  };
}

function assertRefusalAudited(root: string, operation: string): void {
  const entries = readFileSync(join(root, ".kit-audit.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map(
      (line) =>
        JSON.parse(line) as { operation?: string; metadata?: { refused_operation?: string } },
    );
  assert.ok(
    entries.some(
      (entry) =>
        entry.operation === "read-only-mode-refusal" &&
        entry.metadata?.refused_operation === operation,
    ),
  );
}

describe("direct receipt operations in read-only mode", () => {
  it("does not create a key or pending record when prepare is refused", async () => {
    await withFixture(async ({ root, anchor, run }) => {
      const snapshot = captureReviewSnapshot(root, run);
      const transaction = beginReviewTransaction(snapshot.root, run);
      const files = paths(root, transaction.dir, anchor);
      process.env.KIT_READ_ONLY = "1";
      await assert.rejects(
        prepareReviewReceipt(snapshot, transaction, run),
        /read-only mode active/,
      );
      assert.equal(existsSync(files.key), false);
      assert.equal(existsSync(files.pending), false);
      assert.equal(existsSync(files.history), false);
      assert.equal(existsSync(files.receipt), false);
      assert.equal(existsSync(transaction.dir), true);
      assertRefusalAudited(root, "review-prepare-receipt");
    });
  });

  it("does not change the pending record or key when gate recording is refused", async () => {
    await withFixture(async ({ root, anchor, run }) => {
      const snapshot = captureReviewSnapshot(root, run);
      const transaction = beginReviewTransaction(snapshot.root, run);
      await prepareReviewReceipt(snapshot, transaction, run);
      const files = paths(root, transaction.dir, anchor);
      const pending = readFileSync(files.pending);
      const key = readFileSync(files.key);
      process.env.KIT_READ_ONLY = "1";
      await assert.rejects(recordReviewGate(snapshot, transaction, gate), /read-only mode active/);
      assert.deepEqual(readFileSync(files.pending), pending);
      assert.deepEqual(readFileSync(files.key), key);
      assert.equal(existsSync(files.history), false);
      assert.equal(existsSync(files.receipt), false);
      assert.equal(existsSync(transaction.dir), true);
      assertRefusalAudited(root, "review-record-gate");
    });
  });
});

describe("read-only activation during receipt publication", () => {
  for (const phase of ["afterPending", "afterHistory"] as const) {
    it(`does not write receipt state after ${phase}`, async () => {
      await withFixture(async ({ root, anchor, run }) => {
        const snapshot = captureReviewSnapshot(root, run);
        const transaction = beginReviewTransaction(snapshot.root, run);
        await prepareReviewReceipt(snapshot, transaction, run);
        const files = paths(root, transaction.dir, anchor);
        let pending: Buffer | undefined;
        let history: Buffer | undefined;
        let key: Buffer | undefined;
        await assert.rejects(
          writeReviewReceipt(root, gate, {
            run,
            snapshot,
            transaction,
            hooks: {
              [phase]: async () => {
                pending = readFileSync(files.pending);
                key = readFileSync(files.key);
                if (existsSync(files.history)) history = readFileSync(files.history);
                process.env.KIT_READ_ONLY = "1";
              },
            },
          }),
          /read-only mode active/,
        );
        assert.ok(pending);
        assert.ok(key);
        assert.deepEqual(readFileSync(files.pending), pending);
        assert.deepEqual(readFileSync(files.key), key);
        if (history) assert.deepEqual(readFileSync(files.history), history);
        else assert.equal(existsSync(files.history), false);
        assert.equal(existsSync(files.receipt), false);
        assert.equal(existsSync(transaction.dir), true);
        assertRefusalAudited(
          root,
          phase === "afterPending" ? "review-history" : "review-receipt-publish",
        );
      });
    });
  }
});

async function waitForReady(path: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 30000;
  while (!existsSync(path)) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`fixture exited before ready: ${child.exitCode ?? child.signalCode}`);
    if (Date.now() > deadline) throw new Error("fixture did not become ready");
    await new Promise((done) => setTimeout(done, 20));
  }
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((done) => child.once("exit", () => done()));
  child.kill("SIGKILL");
  await exited;
}

describe("read-only activation during recovery", () => {
  it("preserves pending evidence and the lock after assessment", async () => {
    await withFixture(async ({ root, anchor, signals, run }) => {
      const args = isSource
        ? ["--import", import.meta.resolve("tsx"), childFixture, root, "crash", signals]
        : [childFixture, root, "crash", signals];
      const child = spawn(process.execPath, args, {
        env: { ...process.env, KIT_AUDIT_ANCHOR_DIR: anchor, KIT_READ_ONLY: "0" },
        stdio: "ignore",
      });
      try {
        await waitForReady(join(signals, "crash.ready"), child);
        await stopChild(child);
        const lock = resolve(
          root,
          execFileSync("git", ["rev-parse", "--git-path", "kit-review-receipt.lock"], {
            cwd: root,
            encoding: "utf8",
          }).trim(),
        );
        const files = paths(root, lock, anchor);
        let pending: Buffer | undefined;
        let key: Buffer | undefined;
        await assert.rejects(
          recoverReviewReceipt(root, true, run, {
            acknowledgeUnknown: true,
            interruptionReview: "The previous review was interrupted and inspected.",
            afterAssessment: () => {
              pending = readFileSync(files.pending);
              key = readFileSync(files.key);
              process.env.KIT_READ_ONLY = "1";
            },
          }),
          /read-only mode active/,
        );
        assert.ok(pending);
        assert.ok(key);
        assert.deepEqual(readFileSync(files.pending), pending);
        assert.deepEqual(readFileSync(files.key), key);
        assert.equal(existsSync(files.history), false);
        assert.equal(existsSync(files.receipt), false);
        assert.equal(existsSync(lock), true);
        assertRefusalAudited(root, "review-history");
      } finally {
        await stopChild(child);
      }
    });
  });
});
