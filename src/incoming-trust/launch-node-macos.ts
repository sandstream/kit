import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync, rmdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { sameIdentity } from "../utils/same-file.js";
import { privateDirIsControlled } from "../utils/secure-perms.js";
import { runtimeProfile, RUN_ENV, SEATBELT } from "./launch-profile.js";
import type { PreparedLaunchPolicy } from "./launch-policy.js";
import { containsSnapshotPath } from "./snapshot-storage.js";

type Refusal = { ran: false; reason: string };
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
  const deadline = Date.now() + policy.timeoutMs;
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
  const [metadata, profile] = runtimeProfile([input, output, runtime]);
  const result = spawnSync(
    SEATBELT,
    [
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
      entry,
      ctx.authority,
      output,
      runId,
      String(ctx.deadline),
      String(deadline),
      String(process.pid),
      scripts.watchdog,
      String(policy.timeoutMs),
    ],
    {
      cwd: output,
      env: RUN_ENV,
      stdio: ["ignore", "pipe", "pipe", "pipe"],
      encoding: "utf8",
      timeout: policy.timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
    },
  );
  if (result.output?.[3] !== runId) return { ran: false, reason: "runtime-proof-missing" };
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
  const outcome =
    code === "ETIMEDOUT" || (result.signal === "SIGKILL" && Date.now() >= deadline)
      ? "timed-out"
      : code === "ENOBUFS"
        ? "output-limit"
        : result.signal || result.error
          ? "interrupted"
          : "exited";
  return {
    ran: true,
    runId,
    code: result.status,
    outcome,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
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
      !result.ran &&
      sameIdentity(outputIdentity, lstatSync(output, { bigint: true, throwIfNoEntry: false }))
    )
      rmdirSync(output);
    return result;
  } catch {
    return { ran: false, reason: "run-input-or-output-unavailable" };
  }
}
