/**
 * `kit adr derive` — recover the architecture decisions a repo is ALREADY obeying.
 *
 * Taking over an unfamiliar repo, the decisions are in the code, not in `docs/adr`.
 * A layering constraint that holds across every file is a decision whether or not
 * anyone wrote it down — so it can be MEASURED instead of remembered.
 *
 * The unit of evidence is an absent edge with a populated reverse: if `utils` never
 * imports `commands` while `commands` imports `utils` 112 times, that asymmetry is
 * intent, not coincidence. Support (the reverse count) is the evidence weight — a
 * one-file directory with one edge is noise, and the `--min-support` floor exists so
 * the command proposes decisions rather than emitting a catalogue of accidents.
 *
 * Two properties this module is built around:
 *
 *  - It PROPOSES, never decides. A derived ADR is rendered with `status: proposed`,
 *    and `evaluateAdr` ignores every non-accepted ADR — so a draft is inert until a
 *    human edits the status. Promotion stays a deliberate act (same deny-by-default
 *    posture as `.kit/shared`).
 *  - A rule that matches nothing passes trivially. Candidates are therefore derived
 *    over exactly the file set the emitted `paths` glob matches (tests included), so
 *    "zero violations today" is true of the rule as written, not of a tidier subset
 *    the gate would never see. The caller re-runs each draft through the real
 *    evaluator before printing it; anything that fires is dropped, not shown.
 *
 * Zero-LLM and offline: an import graph, set arithmetic, and a TOML block. Prose is
 * never interpreted, and nothing here decides whether a decision is GOOD — only that
 * the codebase currently behaves as if it were made.
 */
import type { RepoGraph } from "./repomap/graph.js";

export interface LayerCandidate {
  /** Subdirectory that never imports `to` (bucket name, not a path). */
  from: string;
  /** Subdirectory it never imports. */
  to: string;
  /** Distinct importer→imported file pairs in the REVERSE direction — the evidence weight. */
  support: number;
  /** Files the emitted `paths` glob covers, so a rule over an empty scope is visible. */
  filesInScope: number;
  /** Source of the `forbid_import` regex. */
  importRegex: string;
  /** The `paths` glob the rule is scoped to. */
  pathsGlob: string;
  /** Message a violation would carry. */
  message: string;
}

export interface DeriveOptions {
  /** Source root the buckets live under, repo-relative posix (e.g. "src"). */
  root: string;
  /** Minimum reverse-edge count before an absent edge is proposed as a decision. */
  minSupport: number;
}

export const DEFAULT_MIN_SUPPORT = 5;

/** Source roots probed, in order, when the caller does not name one. */
export const ROOT_CANDIDATES: readonly string[] = ["src", "lib", "app"];

/**
 * The bucket a repo-relative file belongs to: its first path segment under `root`.
 * Files sitting directly in `root` belong to no bucket (null) — a rule for them would
 * need a different specifier shape (`./x` rather than `../x`), so they are left out
 * rather than guessed at.
 */
export function bucketOf(id: string, root: string): string | null {
  const prefix = `${root}/`;
  if (!id.startsWith(prefix)) return null;
  const rest = id.slice(prefix.length);
  const slash = rest.indexOf("/");
  return slash === -1 ? null : rest.slice(0, slash);
}

/**
 * The specifier regex for "a file under `root/<from>/…` imports `root/<to>/…`".
 *
 * Any depth of `../` is allowed because the importer may sit in a nested directory
 * (`src/a/deep/x.ts` reaches the sibling bucket as `../../to/y.js`). That breadth can
 * over-match when a bucket contains a nested directory named after another bucket
 * (`src/a/deep/../commands` is `src/a/commands`, not `src/commands`) — which is
 * precisely why every candidate is re-run through the real evaluator before it is
 * shown. An over-matching rule reports a violation there and is dropped.
 */
export function importRegexFor(to: string): string {
  return `^(?:\\.\\./)+${to.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`;
}

/** Detect the source root from the graph's file ids, or null when none of the candidates exist. */
export function detectRoot(graph: RepoGraph): string | null {
  for (const root of ROOT_CANDIDATES) {
    if (graph.nodes.some((n) => n.kind === "file" && n.id.startsWith(`${root}/`))) return root;
  }
  return null;
}

/**
 * Absent edges with a populated reverse, ranked by evidence weight.
 *
 * Only subdirectory→subdirectory pairs are considered (see `bucketOf`). Ordering is
 * deterministic: support descending, then bucket names, so two runs over the same tree
 * produce byte-identical output.
 */
export function deriveLayerCandidates(graph: RepoGraph, opts: DeriveOptions): LayerCandidate[] {
  const { root, minSupport } = opts;

  const filesPerBucket = new Map<string, number>();
  for (const node of graph.nodes) {
    if (node.kind !== "file") continue;
    const b = bucketOf(node.id, root);
    if (b) filesPerBucket.set(b, (filesPerBucket.get(b) ?? 0) + 1);
  }

  // Distinct file-pairs per bucket edge. The graph already de-duplicates repeated
  // imports between the same two files, so this counts connections, not statements.
  const edgeCount = new Map<string, number>();
  for (const edge of graph.edges) {
    const from = bucketOf(edge.from, root);
    const to = bucketOf(edge.to, root);
    if (!from || !to || from === to) continue;
    const key = `${from}\u0000${to}`;
    edgeCount.set(key, (edgeCount.get(key) ?? 0) + 1);
  }

  const buckets = [...filesPerBucket.keys()].sort();
  const out: LayerCandidate[] = [];
  for (const from of buckets) {
    for (const to of buckets) {
      if (from === to) continue;
      if (edgeCount.has(`${from}\u0000${to}`)) continue; // the edge exists — no rule to derive
      const support = edgeCount.get(`${to}\u0000${from}`) ?? 0;
      if (support < minSupport) continue;
      out.push({
        from,
        to,
        support,
        filesInScope: filesPerBucket.get(from) ?? 0,
        importRegex: importRegexFor(to),
        pathsGlob: `${root}/${from}/**`,
        message: `${root}/${from} must not import ${root}/${to}`,
      });
    }
  }
  return out.sort(
    (a, b) =>
      b.support - a.support ||
      (a.from < b.from ? -1 : a.from > b.from ? 1 : 0) ||
      (a.to < b.to ? -1 : a.to > b.to ? 1 : 0),
  );
}

/** The `kit-enforce` block a candidate would carry, ready to paste or gate on. */
export function renderCandidateToml(cand: LayerCandidate): string {
  return [
    "[[forbid_import]]",
    `import = ${JSON.stringify(cand.importRegex)}`,
    `paths = ${JSON.stringify(cand.pathsGlob)}`,
    `message = ${JSON.stringify(cand.message)}`,
  ].join("\n");
}

/**
 * A complete draft ADR for a candidate.
 *
 * Emitted as `status: proposed` on purpose: `evaluateAdr` returns nothing for a
 * non-accepted ADR, so the draft can be committed and reviewed without arming a gate
 * nobody has agreed to. Flipping the status to `accepted` is the human's act, and the
 * moment it flips, `kit adr check` enforces it.
 */
export function renderCandidateAdr(cand: LayerCandidate, id: string, title?: string): string {
  const heading = title ?? `${cand.from} does not import ${cand.to}`;
  return `---
id: ${id}
title: ${heading}
status: proposed
---

# ${id}: ${heading}

## Status

Proposed — derived from the code, not yet agreed. \`kit adr check\` ignores a
non-accepted ADR, so this file gates nothing until someone sets \`status: accepted\`.

## Decision

Code under \`${cand.pathsGlob}\` does not import \`${cand.to}\`.

## Evidence

Measured from the import graph, not recalled:

- \`${cand.to}\` imports \`${cand.from}\` across **${cand.support}** distinct file pairs.
- \`${cand.from}\` imports \`${cand.to}\` **zero** times.
- The rule below was evaluated over the ${cand.filesInScope} file(s) its \`paths\` glob
  covers, tests included, and reported no violations.

The asymmetry is the evidence. Whether it was intended is the reviewer's call: accept
this ADR to make it binding, or delete the file to record that it was only a habit.

\`\`\`toml kit-enforce
${renderCandidateToml(cand)}
\`\`\`
`;
}

/**
 * A rule must be able to FAIL, or its green is meaningless. This is the static half of
 * that proof: the emitted regex is checked against the specifier shape a violation
 * would actually use. (The dynamic half — running the rule over the repo — is the
 * caller's verification pass.)
 */
export function ruleWouldFire(cand: LayerCandidate): boolean {
  const re = new RegExp(cand.importRegex);
  return re.test(`../${cand.to}/x.js`) && re.test(`../../${cand.to}/deep/y.js`);
}
