/** Separate process fixture for receipt transactions. */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, linkSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import {
  captureReviewSnapshot,
  collectReviewReceipt,
  prepareReviewReceipt,
  recordReviewGate,
  recoverReviewReceipt,
  resolveReviewInterruption,
  verifyReviewReceiptFile,
  writeReviewReceipt,
  type ReadCommand,
} from "./review-receipt-io.js";
import {
  beginReviewTransaction,
  claimReviewRecovery,
  loadReviewTransaction,
  readReviewPending,
  finishReviewTransaction,
} from "./review-receipt-transaction.js";
import { persistHistory } from "./review-receipt-history-io.js";
import { collectPrEvidence } from "./escalate-pr-io.js";
import { collectPrEscalations } from "./escalate-pr.js";
import { getAuditAnchorKey } from "./audit-anchor.js";
import { signReviewReceipt } from "./review-receipt.js";

const root = process.argv[2]!;
const mode = process.argv[3]!;
const signals = process.argv[4]!;
function stopAtBarrier(): never {
  writeFileSync(join(signals, `${mode}.barrier`), "ready");
  const cell = new Int32Array(new SharedArrayBuffer(4));
  while (true) Atomics.wait(cell, 0, 0, 1000);
}
const head =
  process.env.KIT_TEST_REMOTE_HEAD ??
  execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const refs = {
  defaultBranchRef: { name: "main", target: { oid: head } },
  pullRequest: {
    number: 12,
    headRefOid: head,
    baseRefName: "main",
    baseRef: { target: { oid: head } },
  },
};

function graph(args: string[]): string {
  const query = args.find((value) => value.startsWith("query=")) ?? "";
  if (query.includes("baseRefName baseRef")) return JSON.stringify({ data: { repository: refs } });
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
          author: { login: "fixture" },
          latestOpinionatedReviews: { totalCount: 0, pageInfo: { hasNextPage: false }, nodes: [] },
          reviewThreads: { totalCount: 0, pageInfo: { hasNextPage: false }, nodes: [] },
        },
      },
    },
  });
}

let failRemote = false;
const run: ReadCommand = (command, args, cwd) => {
  if (command === "git") return execFileSync(command, args, { cwd, encoding: "utf8" });
  if (failRemote) throw new Error("simulated GitHub outage");
  if (args[0] === "repo") return '{"nameWithOwner":"sandstream/kit"}';
  if (args[0] === "pr" && mode === "resolve-track-during-gh") {
    execFileSync("git", ["add", ".kit-review-receipt-history.jsonl"], { cwd });
  }
  if (args[0] === "pr")
    return JSON.stringify({
      number: 12,
      headRefOid: head,
      changedFiles: 0,
      files: [],
      statusCheckRollup: [],
    });
  if (args.includes("graphql")) return graph(args);
  if (args.includes("--paginate")) return "[[]]";
  if (args.includes("--jq")) return head;
  throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
};

async function stageCompleted(
  transaction: ReturnType<typeof beginReviewTransaction>,
): Promise<void> {
  const receipt = collectReviewReceipt(
    root,
    {
      command: "kit review --receipt",
      exitCode: 1,
      stdout: mode,
      stderr: "",
    },
    run,
    undefined,
    transaction.runId,
  );
  const signed = signReviewReceipt(receipt, await getAuditAnchorKey());
  writeFileSync(join(transaction.dir, "pending-0123456789abcdef"), JSON.stringify(signed));
}

function crashHooks() {
  return {
    historyPublish:
      mode === "crash-history-link"
        ? (source: Parameters<typeof linkSync>[0], destination: Parameters<typeof linkSync>[1]) => {
            linkSync(source, destination);
            stopAtBarrier();
          }
        : undefined,
    historyWrite:
      mode === "crash-partial-append"
        ? (fd: number, text: string) => {
            const bytes = Buffer.from(text, "utf8");
            writeSync(fd, bytes.subarray(0, Math.floor(bytes.length / 2)));
            stopAtBarrier();
          }
        : undefined,
    afterReceiptTemp: mode === "crash-receipt-temp" ? stopAtBarrier : undefined,
  };
}

async function handleSpecialMode(): Promise<boolean> {
  if (mode === "claim-crash") {
    const canonicalRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    claimReviewRecovery(loadReviewTransaction(canonicalRoot, run));
    writeFileSync(join(signals, `${mode}.ready`), "ready");
    while (!existsSync(join(signals, "release"))) await new Promise((done) => setTimeout(done, 20));
    return true;
  }
  if (mode === "recover" || mode === "recover-reviewed" || mode === "recover-assess-crash") {
    console.log(
      await recoverReviewReceipt(root, true, run, {
        interruptionReview:
          mode !== "recover" ? "Human inspected the available review output." : undefined,
        acknowledgeUnknown: mode !== "recover",
        afterAssessment: mode === "recover-assess-crash" ? stopAtBarrier : undefined,
      }),
    );
    return true;
  }
  if (mode === "verify") {
    const result = await verifyReviewReceiptFile(root, undefined, run);
    console.log(JSON.stringify(result));
    return true;
  }
  if (mode === "resolve" || mode === "resolve-track-during-gh") {
    const runId = readFileSync(join(signals, "unresolved-run"), "utf8").trim();
    console.log(
      await resolveReviewInterruption(
        root,
        runId,
        "Inspected previous output and accepted the remaining unknown risk.",
        true,
        run,
      ),
    );
    return true;
  }
  if (mode === "escalate") {
    const evidence = await collectPrEvidence(root, { mergeDenied: false }, run);
    console.log(JSON.stringify(collectPrEscalations(evidence)));
    return true;
  }
  return false;
}

async function main(): Promise<void> {
  if (await handleSpecialMode()) return;
  if (mode === "append-failure") {
    const history = join(root, ".kit-review-receipt-history.jsonl");
    writeFileSync(history, "");
    chmodSync(history, 0o400);
  }
  const snapshot = captureReviewSnapshot(root, run);
  const transaction = beginReviewTransaction(
    snapshot.root,
    run,
    mode === "crash-ownerless" ? stopAtBarrier : undefined,
  );
  await prepareReviewReceipt(snapshot, transaction, run);
  if (mode === "crash-unknown") stopAtBarrier();
  if (mode === "legacy-interrupted") {
    const pending = readReviewPending(transaction)!;
    persistHistory(root, JSON.parse(pending), await getAuditAnchorKey(), transaction.dir);
    finishReviewTransaction(transaction, undefined, [], pending, true);
    return;
  }
  if (mode === "staged-completed") await stageCompleted(transaction);
  writeFileSync(join(signals, `${mode}.ready`), "ready");
  if (mode === "crash" || mode === "hold" || mode === "staged-completed") {
    while (!existsSync(join(signals, "release"))) {
      await new Promise((done) => setTimeout(done, 20));
    }
  }
  if (mode === "crash-gate" || mode === "gate-network-error") {
    await recordReviewGate(snapshot, transaction, {
      command: "kit review --receipt",
      exitCode: 1,
      stdout: mode,
      stderr: "",
    });
    if (mode === "crash-gate") stopAtBarrier();
    failRemote = true;
  }
  await writeReviewReceipt(
    root,
    {
      command: "kit review --receipt",
      exitCode: mode === "pass" ? 0 : 1,
      stdout: mode,
      stderr: "",
    },
    {
      run,
      snapshot,
      transaction,
      hooks: {
        ...crashHooks(),
        afterPending: async () => {
          if (mode !== "crash-after-pending") return;
          writeFileSync(join(signals, `${mode}.pending`), "ready");
          while (!existsSync(join(signals, "release")))
            await new Promise((done) => setTimeout(done, 20));
        },
        afterHistory: async () => {
          if (mode !== "crash-after-history") return;
          writeFileSync(join(signals, `${mode}.history`), "ready");
          while (!existsSync(join(signals, "release")))
            await new Promise((done) => setTimeout(done, 20));
        },
      },
    },
  );
}

await main();
