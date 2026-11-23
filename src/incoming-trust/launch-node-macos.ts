import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync, rmdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { sameIdentity } from "../utils/same-file.js";
import { privateDirIsControlled } from "../utils/secure-perms.js";
import { runtimeProfile, RUN_ENV } from "./launch-profile.js";
import type { BootstrapRequest } from "./launch-bootstrap.js";
import type { SupervisorReceipt, SupervisorRequest } from "./launch-supervisor.js";
import type { PreparedLaunchPolicy } from "./launch-policy.js";
import { containsSnapshotPath } from "./snapshot-storage.js";

type Refusal = { ran: false | null; reason: string };
export type IncomingRun =
  | Refusal
  | {
      ran: true;
      runId: string;
      code: number | null;
      outcome: "exited" | "timed-out" | "interrupted" | "output-limit" | "boundary-failed";
      boundaryReason?: string;
      stdout: string;
      stderr: string;
    };

interface LaunchContext {
  runtime: string;
  prepared: PreparedLaunchPolicy;
  mounted: string;
  authority: string;
  repository: string;
  source: string;
  verificationDigest: string;
  deadline: number;
}

function rootPaths(ctx: LaunchContext): { input: string; output: string; entry: string } {
  const input = join(ctx.mounted, "tree");
  const output = ctx.prepared.policy.outputDirectory;
  const parent = dirname(output);
  if (realpathSync(parent) !== parent || !privateDirIsControlled(parent))
    throw new Error("uncontrolled output parent");
  const protectedPaths = [ctx.repository, dirname(ctx.authority), ctx.source, dirname(ctx.mounted)];
  for (const path of protectedPaths.map((item) => realpathSync(item))) {
    if (containsSnapshotPath(path, output) || containsSnapshotPath(output, path))
      throw new Error("output overlaps protected input");
  }
  const entry = realpathSync(join(input, ctx.prepared.policy.entry));
  if (!containsSnapshotPath(input, entry) || !lstatSync(entry).isFile())
    throw new Error("entry is outside the retained tree");
  return { input, output, entry };
}

function invoke(ctx: LaunchContext, input: string, output: string, entry: string): IncomingRun {
  const { policyDigest, policy, scripts } = ctx.prepared;
  const { runtime } = ctx;
  const runId = createHash("sha256")
    .update(
      JSON.stringify([
        "kit.incoming-run",
        1,
        ctx.verificationDigest,
        policyDigest,
        randomBytes(16).toString("hex"),
      ]),
    )
    .digest("hex");
  const [metadata, profile] = runtimeProfile({ input, output, runtime });
  const entryRequest: BootstrapRequest = {
    entry,
    authority: ctx.authority,
    output,
    runId,
    approvalDeadline: ctx.deadline,
  };
  const supervisor: SupervisorRequest = {
    parent: process.pid,
    deadlineMs: policy.timeoutMs,
    env: RUN_ENV,
    args: [
      "-D",
      "KIT_RUNTIME=" + runtime,
      "-D",
      "KIT_INPUT=" + input,
      "-D",
      "KIT_OUTPUT=" + output,
      ...metadata,
      "-p",
      profile,
      runtime,
      "--input-type=module",
      "-e",
      scripts.bootstrap,
      "--",
      JSON.stringify(entryRequest),
    ],
  };
  const result = spawnSync(
    runtime,
    ["--input-type=module", "-e", scripts.supervisor, "--", JSON.stringify(supervisor)],
    {
      cwd: output,
      env: RUN_ENV,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      timeout: policy.timeoutMs + 10_000,
      killSignal: "SIGKILL",
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (result.status !== 0 || result.error || !result.stdout)
    return { ran: null, reason: "run-supervisor-result-unavailable" };
  const confirmed = parseReceipt(result.stdout);
  if (!confirmed) return { ran: null, reason: "run-supervisor-result-unavailable" };
  const { proof, ...receipt } = confirmed;
  return proof === runId
    ? { ran: true, runId, ...receipt }
    : { ran: false, reason: "runtime-proof-missing" };
}

function parseReceipt(output: string): SupervisorReceipt | undefined {
  try {
    const receipt = JSON.parse(output) as Partial<SupervisorReceipt> | null;
    if (!receipt || typeof receipt.proof !== "string" || receipt.proof.length > 64)
      return undefined;
    if (receipt.code !== null && !Number.isInteger(receipt.code)) return undefined;
    if (!["exited", "timed-out", "interrupted", "output-limit"].includes(receipt.outcome ?? ""))
      return undefined;
    if (typeof receipt.stdout !== "string" || typeof receipt.stderr !== "string") return undefined;
    return receipt as SupervisorReceipt;
  } catch {
    return undefined;
  }
}

/** Starts the one supported delegate. The caller holds the lock and the sealed image. */
export function launchNodeOnMac(ctx: LaunchContext): IncomingRun {
  if (!ctx.prepared.checkRuntime()) return { ran: false, reason: "run-runtime-changed" };
  if (Date.now() >= ctx.deadline) return { ran: false, reason: "stale-approval" };
  try {
    const { input, output, entry } = rootPaths(ctx);
    mkdirSync(output, { mode: 0o700 });
    const outputIdentity = lstatSync(output, { bigint: true });
    const result = invoke(ctx, input, output, entry);
    if (
      result.ran === false &&
      sameIdentity(outputIdentity, lstatSync(output, { bigint: true, throwIfNoEntry: false }))
    )
      rmdirSync(output);
    return result;
  } catch {
    return { ran: false, reason: "run-input-or-output-unavailable" };
  }
}
