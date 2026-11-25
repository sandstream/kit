/**
 * `kit review gate --pr <n> [--repo owner/name] [--json]` — the deterministic review gate kit's
 * reviewer App applies, as a read-only command any maintainer can run on any pull request.
 *
 * Harness-neutral: it reads GitHub (the pull request, its files and checks, the default branch),
 * not the agent that wrote the change, so it judges a Claude, Codex or human pull request the same.
 * It never posts a review or a comment; posting stays with the App. It prints one verdict, the
 * reasons and the exact head commit it judged, exits with that verdict's code, and appends one row
 * to kit's audit log (when audit is on) recording who decided what on which head.
 */
import { resolve } from "node:path";
import { flagValue, hasFlag } from "../utils/flags.js";
import { classifyProtectedPaths } from "../review-protected-paths.js";
import { widePaths } from "../review-protected-paths-wide.js";
import { decideGate, VERDICT_EXIT, type GateDecision } from "../review-gate.js";
import { gitHubReader, readGate, type Fetcher, type GateReads } from "../review-gate-github.js";
import { importerCountsAtCommit, type GitRun } from "../review-gate-importers.js";

export interface ReviewGateDeps {
  fetcher?: Fetcher;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** owner/name of the clone at cwd, from its origin remote. */
  originRepo?: (cwd: string) => string | undefined;
  git?: GitRun;
  log?: (line: string) => void;
}

export interface ReviewGateResult extends GateDecision {
  repo: string;
  pr: number;
  head_sha: string | null;
  exit_code: number;
  decided_at: string;
  decided_by: string;
  rules: string;
  wide: string;
  checks: GateReads["checks"];
  main: GateReads["main"];
  pull_state: string | null;
}

const REPO = /^[A-Za-z0-9][A-Za-z0-9-]*\/(?!\.\.?$)[A-Za-z0-9_.-]+$/;
const DECIDED_BY = "kit review gate (deterministic, read-only)";

async function originOf(cwd: string): Promise<string | undefined> {
  const { repoIdentity } = await import("../audit.js");
  return repoIdentity(cwd);
}

function usage(text: string): never {
  throw Object.assign(new Error(text), { usage: true });
}

function parseArgs(argv: readonly string[]): { pr: number; repo?: string; json: boolean } {
  const raw = flagValue(argv, "--pr");
  const pr = Number(raw);
  if (!raw || !Number.isInteger(pr) || pr <= 0) usage("usage: kit review gate --pr <number>");
  const repo = flagValue(argv, "--repo");
  if (repo !== undefined && !REPO.test(repo)) usage("--repo must be owner/name");
  return { pr, repo, json: hasFlag(argv, "--json") };
}

/** The wide lane at the default branch's head, from the local clone when it is a clone of repo. */
function wideLane(
  reads: GateReads,
  repo: string,
  cwd: string,
  origin: string | undefined,
  git: GitRun | undefined,
): { paths: { path: string; importers: number }[]; note: string; unread?: string } {
  if (!reads.main) return { paths: [], note: "not measured (default branch unread)" };
  const at = `${reads.main.branch}@${reads.main.sha.slice(0, 12)}`;
  if (!origin || origin.toLowerCase() !== repo.toLowerCase()) {
    const unread = `the wide lane needs a clone of ${repo}: run kit review gate from one`;
    return { paths: [], note: "not measured (not run from a clone of this repository)", unread };
  }
  try {
    const counts = importerCountsAtCommit(cwd, reads.main.sha, git);
    return {
      paths: widePaths(reads.paths, counts),
      note: `counted at ${at} (${counts.size} imported modules)`,
    };
  } catch {
    const unread = `the wide lane could not read ${at} from the local clone: run git fetch origin ${reads.main.branch}`;
    return { paths: [], note: "not measured (default branch head not in the local clone)", unread };
  }
}

function rulesNote(reads: GateReads): string {
  if (reads.rulesSource === "repo") return ".github/kit-protected-paths.json on the default branch";
  if (reads.rulesSource === "default")
    return "kit's built-in protected paths (the default branch has no .github/kit-protected-paths.json)";
  return "not read";
}

function pullState(pull: GateReads["pull"]): string | null {
  if (!pull) return null;
  return `${pull.merged ? "merged" : pull.state}${pull.draft ? " (draft)" : ""}`;
}

function resultOf(
  repo: string,
  pr: number,
  reads: GateReads,
  wide: ReturnType<typeof wideLane> | null,
  decision: GateDecision,
): ReviewGateResult {
  return {
    ...decision,
    repo,
    pr,
    head_sha: reads.pull?.headSha ?? null,
    exit_code: VERDICT_EXIT[decision.verdict],
    decided_at: new Date().toISOString(),
    decided_by: DECIDED_BY,
    rules: rulesNote(reads),
    wide: wide?.note ?? "not measured",
    checks: reads.checks,
    main: reads.main,
    pull_state: pullState(reads.pull),
  };
}

/** Read, decide and describe one pull request. Never posts anything. */
async function judgePullRequest(
  repo: string,
  pr: number,
  deps: ReviewGateDeps = {},
): Promise<ReviewGateResult> {
  const env = deps.env ?? process.env;
  const cwd = resolve(deps.cwd ?? process.cwd());
  const token = env.GITHUB_TOKEN || env.GH_TOKEN || undefined;
  const reads = await readGate(gitHubReader(token, deps.fetcher), repo, pr);
  const origin = await (deps.originRepo ?? originOf)(cwd);
  const wide = reads.pull ? wideLane(reads, repo, cwd, origin, deps.git) : null;
  const decision = decideGate({
    checks: reads.checks ?? { state: "green", failed: [], total: 0 },
    protectedPaths: classifyProtectedPaths(reads.paths, reads.rules),
    widePaths: wide?.paths ?? [],
    changedLines: reads.changedLines,
    truncated: reads.truncated,
    main: reads.main,
    unread: wide?.unread ? [...reads.unread, wide.unread] : reads.unread,
  });
  return resultOf(repo, pr, reads, wide, decision);
}

function render(result: ReviewGateResult): string[] {
  const checks = result.checks
    ? `${result.checks.state} (${result.checks.total} checks)`
    : "not read";
  const main = result.main
    ? `${result.main.red.length ? "red" : "not red"} at ${result.main.branch}@${result.main.sha.slice(0, 12)}`
    : "not read";
  return [
    `kit review gate: ${result.repo}#${result.pr} (${result.pull_state ?? "unread"})`,
    `head:    ${result.head_sha ?? "unknown (not read)"}`,
    `verdict: ${result.verdict} (exit ${result.exit_code})`,
    ...result.reasons.map((r) => `  - [${r.verdict}] ${r.text}`),
    `checks:  ${checks}`,
    `main:    ${main}`,
    `rules:   ${result.rules}`,
    `wide:    ${result.wide}`,
    "Read-only: nothing was posted to the pull request.",
  ];
}

/** One audit row per run: who decided what on which head. Best-effort, like the floor audit. */
async function auditGate(result: ReviewGateResult, cwd: string): Promise<void> {
  try {
    const { loadConfig } = await import("../config.js");
    const { mergeGovernanceConfigAsync } = await import("../governance.js");
    const { logAuditEvent } = await import("../audit.js");
    const cfg = await loadConfig(resolve(cwd, ".kit.toml")).catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    });
    const gov = await mergeGovernanceConfigAsync(cfg?.governance);
    await logAuditEvent(
      gov,
      {
        operation: "review.gate",
        environment: gov.environment,
        success: result.verdict === "approve",
        metadata: {
          target_repo: result.repo,
          pr: result.pr,
          head_sha: result.head_sha,
          verdict: result.verdict,
          reasons: result.reasons.map((r) => `[${r.verdict}] ${r.text}`),
          decided_at: result.decided_at,
          decided_by: result.decided_by,
        },
      },
      { cwd },
    );
  } catch {
    /* best-effort: the printed verdict is the decision; the log row records it */
  }
}

/** The CLI entry: `kit review gate`. Returns true only on approve; process.exitCode carries the verdict. */
export async function cmdReviewGate(
  argv: readonly string[] = process.argv,
  deps: ReviewGateDeps = {},
): Promise<boolean> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const cwd = resolve(deps.cwd ?? process.cwd());
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(`✗ ${(error as Error).message}`);
    process.exitCode = 2;
    return false;
  }
  const repo = args.repo ?? (await (deps.originRepo ?? originOf)(cwd));
  if (!repo || !REPO.test(repo)) {
    console.error("✗ no --repo given and the origin remote is not owner/name");
    process.exitCode = 2;
    return false;
  }
  const result = await judgePullRequest(repo, args.pr, { ...deps, cwd });
  await auditGate(result, cwd);
  if (args.json) log(JSON.stringify(result, null, 2));
  else for (const line of render(result)) log(line);
  process.exitCode = result.exit_code;
  return result.verdict === "approve";
}
