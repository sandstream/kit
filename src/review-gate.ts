/**
 * The deterministic review gate's decision, as a pure function anyone can run on their own pull
 * request (`kit review gate --pr <n>`). No model, no judgement of the change.
 *
 * The same gates `scripts/agent-review-gate.mjs` applies before kit's reviewer App approves a
 * commit: every check passed, no file is in a protected class, no changed module is imported by
 * WIDE_IMPORTERS or more modules, the change is under MAX_CHANGED_LINES, and the default branch's
 * own CI is not red. The reason texts are the script's, word for word, and
 * src/review-gate-parity.test.ts feeds both the same fixtures so the two cannot drift.
 *
 * Unlike the App, this returns five verdicts instead of approve/comment, so a person or another
 * harness can tell "a person must look" from "wait" from "fix CI" from "could not read":
 *   approve     every gate passed;
 *   owner       routed to a person: a protected path, a wide module, or over the line limit;
 *   hold        a check failed, or the default branch is red;
 *   pending     a check is still running (or none has reported yet);
 *   incomplete  something could not be read. Fail-closed: a read error never approves.
 * The most severe verdict wins, in the order incomplete, pending, hold, owner, approve.
 */

export const MAX_CHANGED_LINES = 1500;

/** The checks on the default branch's head that the hold reads: the CI workflow's job. */
export const MAIN_CHECKS: readonly string[] = ["build-and-test"];

const OK = new Set(["success", "skipped", "neutral"]);

export interface CheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  started_at?: string | null;
}

export interface ChecksState {
  state: "pending" | "failed" | "green";
  failed: string[];
  total: number;
}

/** The newest run per check name: a re-run replaces the earlier result. Pure. */
export function latestChecks<T extends CheckRun>(runs: readonly T[]): T[] {
  const latest = new Map<string, T>();
  for (const run of runs) {
    const prev = latest.get(run.name);
    if (!prev || String(run.started_at ?? "") >= String(prev.started_at ?? ""))
      latest.set(run.name, run);
  }
  return [...latest.values()];
}

/** pending while any check runs; failed lists the checks that did not pass. Pure. */
export function checksState(runs: readonly CheckRun[]): ChecksState {
  const latest = latestChecks(runs);
  if (latest.length === 0) return { state: "pending", failed: [], total: 0 };
  if (latest.some((r) => r.status !== "completed"))
    return { state: "pending", failed: [], total: latest.length };
  const failed = latest
    .filter((r) => !OK.has(r.conclusion ?? ""))
    .map((r) => r.name)
    .sort();
  return { state: failed.length ? "failed" : "green", failed, total: latest.length };
}

/**
 * Whether the default branch is red: the newest result of each named check on its head commit.
 * Pending or absent checks are not red, so a fresh merge does not hold every pull request while its
 * own CI runs. Pure.
 */
export function mainRed(
  runs: readonly CheckRun[],
  names: readonly string[] = MAIN_CHECKS,
): string[] {
  const latest = latestChecks(runs.filter((r) => names.includes(r.name)));
  return latest
    .filter((r) => r.status === "completed" && !OK.has(r.conclusion ?? ""))
    .map((r) => r.name)
    .sort();
}

export type GateVerdict = "approve" | "owner" | "hold" | "pending" | "incomplete";

/** Most severe first. */
const VERDICT_ORDER: readonly GateVerdict[] = ["incomplete", "pending", "hold", "owner", "approve"];

/** Distinct exit codes, one per verdict (2 stays the CLI's usage error). */
export const VERDICT_EXIT: Readonly<Record<GateVerdict, number>> = {
  approve: 0,
  owner: 3,
  hold: 4,
  pending: 5,
  incomplete: 6,
};

export interface GateInput {
  checks: ChecksState;
  protectedPaths: readonly { path: string; classes: readonly string[] }[];
  widePaths?: readonly { path: string; importers: number }[];
  changedLines: number;
  /** The API cut the file list short, so not every path was classified. */
  truncated: boolean;
  main?: { sha: string; red: readonly string[] } | null;
  /** What could not be read. Any entry makes the verdict incomplete. */
  unread?: readonly string[];
}

export interface GateReason {
  verdict: Exclude<GateVerdict, "approve">;
  text: string;
}

export interface GateDecision {
  verdict: GateVerdict;
  reasons: GateReason[];
}

function protectedReason(paths: GateInput["protectedPaths"]): string {
  const classes = [...new Set(paths.flatMap((p) => p.classes))].sort().join(", ");
  const list = paths
    .slice(0, 10)
    .map((p) => `\`${p.path}\``)
    .join(", ");
  return `touches protected paths (${classes}), which the owner approves: ${list}`;
}

function wideReason(paths: NonNullable<GateInput["widePaths"]>): string {
  const list = paths
    .slice(0, 10)
    .map((p) => `\`${p.path}\` (${p.importers} importers)`)
    .join(", ");
  return `changes modules many others import, which the owner approves: ${list}`;
}

function checksReason(checks: ChecksState): GateReason | null {
  if (checks.state === "failed")
    return { verdict: "hold", text: `checks did not pass: ${checks.failed.join(", ")}` };
  if (checks.state === "pending")
    return {
      verdict: "pending",
      text: checks.total
        ? `checks still running on this commit (${checks.total} reported so far)`
        : "no check has reported on this commit yet",
    };
  return null;
}

function mainReason(main: GateInput["main"]): GateReason | null {
  if (!main || !main.red.length) return null;
  return {
    verdict: "hold",
    text:
      `the default branch is red at \`${main.sha.slice(0, 12)}\` (${main.red.join(", ")} failed): ` +
      "a merge now would stack on the breakage, so a person approves until main is green again",
  };
}

/** Every reason, in the script's order (checks, protected, wide, truncated, main, size), then reads. */
function gateReasons(input: GateInput): GateReason[] {
  const reasons: (GateReason | null)[] = [checksReason(input.checks)];
  if (input.protectedPaths.length)
    reasons.push({ verdict: "owner", text: protectedReason(input.protectedPaths) });
  if (input.widePaths?.length)
    reasons.push({ verdict: "owner", text: wideReason(input.widePaths) });
  if (input.truncated)
    reasons.push({
      verdict: "incomplete",
      text: "the file list was truncated by the API, so not every path was classified",
    });
  reasons.push(mainReason(input.main));
  if (input.changedLines > MAX_CHANGED_LINES)
    reasons.push({
      verdict: "owner",
      text: `${input.changedLines} changed lines, over the ${MAX_CHANGED_LINES}-line limit for a gate-only approval`,
    });
  for (const text of input.unread ?? []) reasons.push({ verdict: "incomplete", text });
  return reasons.filter((r): r is GateReason => r !== null);
}

/** The verdict for one pull request at one commit: the most severe reason's, or approve. Pure. */
export function decideGate(input: GateInput): GateDecision {
  const reasons = gateReasons(input);
  const verdict =
    VERDICT_ORDER.find((v) => reasons.some((r) => r.verdict === v)) ?? ("approve" as const);
  return { verdict, reasons };
}
