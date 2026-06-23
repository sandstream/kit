/**
 * Sentinel layer 2 — the agent-agnostic responder.
 *
 * kit PROPOSES, any agent DISPOSES, any scheduler TRIGGERS. This module is the
 * "propose" half: it deterministically turns red findings (layer 1) into a typed
 * remediation-proposal document. kit never calls an LLM and never opens a PR/issue
 * — `kit sentinel run --json` emits the proposals; whichever agent (Claude Code,
 * Codex, Cursor, …) reads the stable JSON and performs the writes with its own
 * model + creds. The JSON contract is the agnostic seam.
 *
 * See docs/specs/2026-06-23-sentinel-layer2-responder.md.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { HealthFinding } from "./health.js";

export type FindingClass = "code" | "human" | "noise";
export type Artifact = "draft-pr" | "issue" | "suppression-pr";

/** Normalized red finding (the responder's input — source-agnostic). */
export interface RedFinding {
  id: string; // stable; the dedup + suppression key
  class: FindingClass;
  title: string;
  detail?: string;
}

export interface Proposal {
  findingId: string;
  class: FindingClass;
  artifact: Artifact;
  title: string;
  body: string;
  branch?: string;
  labels: string[];
  suggestedCommands?: string[];
  /** true = an artifact with this finding's marker is already open; null = not checked. */
  alreadyOpen: boolean | null;
}

/** The body marker that makes an artifact dedup-able + traceable to its finding. */
export function findingMarker(id: string): string {
  return `<!-- kit-sentinel:${id} -->`;
}

export function artifactForClass(c: FindingClass): Artifact {
  return c === "code" ? "draft-pr" : c === "human" ? "issue" : "suppression-pr";
}

function slug(id: string): string {
  return id
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

/** Map a layer-1 health finding to the normalized responder shape (red only). */
export function healthToRedFindings(findings: HealthFinding[]): RedFinding[] {
  return findings
    .filter((f) => f.status === "red")
    .map((f) => ({
      id: `health:${f.sensor}`,
      // unclassified red defaults to `human` (needs a person to look), never `noise`.
      class: (f.suggestedClass ?? "human") as FindingClass,
      title: f.title,
      detail: f.detail,
    }));
}

/** One finding → one typed proposal (pure). */
export function buildProposal(f: RedFinding): Proposal {
  const artifact = artifactForClass(f.class);
  const marker = findingMarker(f.id);
  const body = [
    f.detail ?? f.title,
    "",
    marker,
    "",
    "_Proposed by `kit sentinel` (layer 2). kit detects deterministically; you (the agent) make the change and open this artifact._",
  ].join("\n");
  const proposal: Proposal = {
    findingId: f.id,
    class: f.class,
    artifact,
    title: artifact === "suppression-pr" ? `chore(sentinel): suppress ${f.id}` : f.title,
    body,
    labels: ["kit-sentinel", f.class],
    alreadyOpen: null,
  };
  if (artifact !== "issue") proposal.branch = `kit/sentinel/${slug(f.id)}`;
  if (artifact === "suppression-pr") {
    proposal.suggestedCommands = [`add "${f.id}" to .kit/sentinel-suppress.toml`];
  }
  return proposal;
}

/** Findings (minus suppressed) → proposals. Pure. */
export function buildProposals(
  findings: RedFinding[],
  suppressed: ReadonlySet<string> = new Set(),
): Proposal[] {
  return findings.filter((f) => !suppressed.has(f.id)).map(buildProposal);
}

/** Mark proposals whose finding already has an open artifact (null openMarkers = not checked). */
export function applyDedup(
  proposals: Proposal[],
  openMarkers: ReadonlySet<string> | null,
): Proposal[] {
  return proposals.map((p) => ({
    ...p,
    alreadyOpen: openMarkers ? openMarkers.has(p.findingId) : null,
  }));
}

/** Parse `.kit/sentinel-suppress.toml` — `suppress = ["id-a", "id-b"]`. */
export function parseSuppressions(toml: string): Set<string> {
  const ids = new Set<string>();
  const m = /suppress\s*=\s*\[([^\]]*)\]/s.exec(toml);
  if (m) for (const q of m[1].matchAll(/"([^"]+)"|'([^']+)'/g)) ids.add(q[1] ?? q[2]);
  return ids;
}

export interface SentinelDeps {
  /** Gather the current red findings (layer 1). */
  gatherRed(): Promise<RedFinding[]>;
  /** Markers of findings that already have an open artifact (null = couldn't check). */
  openMarkers(): Promise<ReadonlySet<string> | null>;
}

/** Build the agent-agnostic proposal set: gather → drop suppressed → build → dedup. */
export async function runSentinel(cwd: string, deps: SentinelDeps): Promise<Proposal[]> {
  let suppressed = new Set<string>();
  try {
    suppressed = parseSuppressions(
      readFileSync(resolve(cwd, ".kit", "sentinel-suppress.toml"), "utf8"),
    );
  } catch {
    // no suppress file → nothing suppressed
  }
  const findings = await deps.gatherRed();
  const proposals = buildProposals(findings, suppressed);
  return applyDedup(proposals, await deps.openMarkers());
}

// ── Layer 3: scheduling + surfacing (#53) ──────────────────────────────────
// L2 produces proposals on demand; L3 makes them RECUR (a scheduler) and makes
// the result VISIBLE between runs (a cached summary a SessionStart hook reads).
// Both halves stay zero-LLM + agent-agnostic: `kit sentinel install` scaffolds a
// scheduler that runs `kit sentinel run --json`; any agent (or the job itself)
// acts on that JSON. Nothing here opens an artifact or needs creds.

/** Repo-relative path to the cached summary the SessionStart surface reads. */
export const SENTINEL_CACHE = ".kit/sentinel.json";

/** A compact, serialisable digest of a proposal set — what L3 caches + surfaces. */
export interface SentinelSummary {
  total: number;
  fresh: number;
  byClass: Record<FindingClass, number>;
}

/** Digest proposals for caching/surfacing (pure). `fresh` = not already open. */
export function proposalSummary(proposals: Proposal[]): SentinelSummary {
  const byClass: Record<FindingClass, number> = { code: 0, human: 0, noise: 0 };
  let fresh = 0;
  for (const p of proposals) {
    byClass[p.class]++;
    if (p.alreadyOpen !== true) fresh++;
  }
  return { total: proposals.length, fresh, byClass };
}

/** One-line SessionStart surface, e.g. `[sentinel · 3 fresh, 1 need you]`. null = stay quiet. */
export function sentinelStatusLine(s: SentinelSummary | null | undefined): string | null {
  if (!s || s.fresh === 0) return null;
  const human = s.byClass.human > 0 ? `, ${s.byClass.human} need you` : "";
  return `[sentinel · ${s.fresh} fresh${human}]`;
}

/**
 * GitHub Actions workflow that recurs `kit sentinel run` (#53 L3 scheduler).
 * Read-only by default: it emits the proposal JSON; an agent step acts on it.
 * GHA expression syntax is backslash-escaped so it survives the template literal.
 */
export function sentinelWorkflow(schedule = "0 7 * * 1"): string {
  return `# Generated by \`kit sentinel install\` — layer-3 scheduler (#53).
# Recurs the agent-agnostic responder; an agent (or a downstream step) acts on the JSON.
name: kit-sentinel
on:
  schedule:
    - cron: "${schedule}"
  workflow_dispatch: {}
permissions:
  contents: read
  issues: write
  pull-requests: write
jobs:
  sentinel:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: kit sentinel run
        run: npx --yes sandstream-kit sentinel run --json | tee sentinel.json
        env:
          GH_TOKEN: \${{ github.token }}
`;
}
