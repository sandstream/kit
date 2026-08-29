/**
 * `kit adr derive` — the CLI half of architecture recovery.
 *
 * Kept OUT of `commands/adr.ts` on purpose. kit derives each command's accepted flags by
 * walking the handler's import graph one level deep, and `commands/adr.ts` is imported by
 * `review`, `baseline` and `standards` (they embed `adrCheck`). Parsing argv there would
 * make `--root` / `--min-support` / `--emit` land in THEIR allowlists too — flags those
 * commands would then accept and silently ignore. One module deeper, they belong to
 * `kit adr` alone, which is where they are actually read.
 *
 * See `src/adr-derive.ts` for the derivation itself (pure); this file owns argv, the
 * repo-backed verification pass, and rendering.
 */
import { readFileSync as read } from "node:fs";
import { relative as rel } from "node:path";
import { c } from "../utils/colors.js";
import { hasFlag, flagValue } from "../utils/flags.js";
import { walkSourceFiles } from "../source-walk.js";
import { parseAdr, evaluateAdr, type Adr } from "../adr.js";
import { createNodeModulesResolver } from "./adr.js";
import {
  deriveLayerCandidates,
  renderCandidateAdr,
  renderCandidateToml,
  detectRoot,
  ruleWouldFire,
  DEFAULT_MIN_SUPPORT,
  type LayerCandidate,
} from "../adr-derive.js";
import type { RepoGraph } from "../repomap/graph.js";

/** Same extension set the ADR gate walks, so derivation sees exactly what enforcement will. */
const CODE_EXTS = [".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java", ".rb", ".php"];

/** Every code file in the repo, as the pure evaluator wants them. */
function repoFiles(cwd: string): { path: string; content: string }[] {
  return walkSourceFiles(cwd, { exts: CODE_EXTS, includeTests: true }).map((f) => ({
    path: rel(cwd, f),
    content: read(f, "utf-8"),
  }));
}

export interface VerifiedCandidate {
  candidate: LayerCandidate;
  /** The draft ADR markdown, rendered exactly as it would be committed. */
  draft: string;
}

export interface DeriveOutcome {
  root: string;
  proposed: VerifiedCandidate[];
  /** Candidates the verification pass rejected — reported, never silently dropped. */
  rejected: { candidate: LayerCandidate; reason: string }[];
}

/**
 * Derive candidates and PROVE each one before showing it.
 *
 * Two ways a proposal can be wrong, and both are checked here rather than left for the
 * reader: the rendered ADR might not parse (then it is not a draft, it is a text file),
 * and the rule might over-match some path shape the graph did not reveal. Verification
 * runs the real evaluator over the real repo with the ADR temporarily treated as
 * accepted — the same code path `kit adr check` would take once a human accepts it.
 */
export function deriveAdrs(
  cwd: string,
  graph: RepoGraph,
  opts: { root?: string; minSupport?: number } = {},
): DeriveOutcome | null {
  const root = opts.root ?? detectRoot(graph);
  if (!root) return null;

  const candidates = deriveLayerCandidates(graph, {
    root,
    minSupport: opts.minSupport ?? DEFAULT_MIN_SUPPORT,
  });
  if (candidates.length === 0) return { root, proposed: [], rejected: [] };

  const files = repoFiles(cwd);
  const packages = createNodeModulesResolver(cwd);
  const proposed: VerifiedCandidate[] = [];
  const rejected: { candidate: LayerCandidate; reason: string }[] = [];

  for (const candidate of candidates) {
    if (!ruleWouldFire(candidate)) {
      rejected.push({ candidate, reason: "rule cannot match a violating specifier" });
      continue;
    }
    const draft = renderCandidateAdr(candidate, "ADR-XXXX");
    const parsed = parseAdr(draft);
    if (!parsed || parsed.rules.length !== 1) {
      rejected.push({ candidate, reason: "rendered draft does not parse to exactly one rule" });
      continue;
    }
    // The draft ships `proposed` (inert). Verify it as the gate would see it once accepted.
    const armed: Adr = { ...parsed, status: "accepted" };
    const findings = evaluateAdr(armed, files, { packages });
    if (findings.length > 0) {
      const f = findings[0];
      rejected.push({
        candidate,
        reason: `rule fires today (${findings.length} finding(s), first: ${f.file}:${f.line})`,
      });
      continue;
    }
    proposed.push({ candidate, draft });
  }
  return { root, proposed, rejected };
}

export async function adrDerive(cwd: string): Promise<boolean> {
  const { buildRepoGraph } = await import("./repomap.js");
  const minSupportRaw = flagValue(process.argv, "--min-support");
  const minSupport = minSupportRaw ? Number(minSupportRaw) : DEFAULT_MIN_SUPPORT;
  if (!Number.isFinite(minSupport) || minSupport < 1) {
    console.error(`${c.red}--min-support must be a positive integer${c.reset}`);
    return false;
  }
  const rootFlag = flagValue(process.argv, "--root");
  const json = hasFlag(process.argv, "--json");

  const outcome = deriveAdrs(cwd, buildRepoGraph(cwd), { root: rootFlag, minSupport });

  if (!outcome) {
    const msg = `no source root found (looked for src/, lib/, app/) — pass --root <dir>`;
    if (json) console.log(JSON.stringify({ proposed: [], rejected: [], error: msg }, null, 2));
    else console.error(`${c.yellow}!${c.reset} ${msg}`);
    return false;
  }

  if (json) {
    console.log(
      JSON.stringify(
        {
          root: outcome.root,
          minSupport,
          proposed: outcome.proposed.map((p) => ({ ...p.candidate, draft: p.draft })),
          rejected: outcome.rejected.map((r) => ({ ...r.candidate, reason: r.reason })),
        },
        null,
        2,
      ),
    );
    return true;
  }

  const emit = flagValue(process.argv, "--emit");
  if (emit) {
    const [from, to] = emit.split("/");
    const hit = outcome.proposed.find((p) => p.candidate.from === from && p.candidate.to === to);
    if (!hit) {
      console.error(
        `${c.red}no verified candidate '${emit}'${c.reset} — run without --emit to list them`,
      );
      return false;
    }
    process.stdout.write(hit.draft);
    return true;
  }

  console.log(
    `${c.bold}kit adr derive${c.reset} ${c.dim}— decisions this repo already obeys (root: ${outcome.root}, min-support: ${minSupport})${c.reset}\n`,
  );

  if (outcome.proposed.length === 0) {
    console.log(`${c.dim}No layering candidate cleared the evidence floor.${c.reset}`);
  }
  for (const { candidate: k } of outcome.proposed) {
    console.log(
      `  ${c.green}◆${c.reset} ${c.bold}${k.from}${c.reset} never imports ${c.bold}${k.to}${c.reset}` +
        `  ${c.dim}support ${k.support} reverse edge(s) · ${k.filesInScope} file(s) in scope${c.reset}`,
    );
    for (const line of renderCandidateToml(k).split("\n")) {
      console.log(`      ${c.dim}${line}${c.reset}`);
    }
  }

  if (outcome.rejected.length > 0) {
    console.log(`\n  ${c.dim}not proposed — the rule did not survive verification:${c.reset}`);
    for (const r of outcome.rejected) {
      console.log(
        `  ${c.yellow}−${c.reset} ${r.candidate.from} → ${r.candidate.to}  ${c.dim}${r.reason}${c.reset}`,
      );
    }
  }

  if (outcome.proposed.length > 0) {
    console.log(
      `\n${c.dim}These are PROPOSALS measured from the import graph, not decisions. ` +
        `Write one to docs/adr with \`kit adr derive --emit <from>/<to> > docs/adr/NNNN-x.md\`; ` +
        `it lands as status: proposed and gates nothing until you set it to accepted.${c.reset}`,
    );
  }
  return true;
}
