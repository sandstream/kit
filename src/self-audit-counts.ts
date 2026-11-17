// Class 17 analyzer for `kit self-audit`: numeric claims about kit's own countable sets.
//
// A manual pass (#864) found kit's docs stating counts that had drifted: `docs/adr`
// "holds seven ADRs" when it held nine, and `kit self-audit --help` naming "12
// self-hardening rules" when there were 16. R14 checks that a documented command, flag
// or section exists; it has no notion of how MANY there are. This rule does, for the
// sets kit can count deterministically:
//
//   ADRs                  docs/adr/NNNN-*.md
//   self-audit rules      the self-audit rule table (passed in by the registry)
//   runtime deps          package.json `dependencies`
//   commands, by tier     contracts/kit.opencli.json top-level commands, x-kit-stability
//
// Only phrasings whose noun names one of those sets are read, digits or number words:
// `nine ADRs`, `16 self-hardening rules`, `four runtime deps`, `kit's 80 commands`,
// `27 experimental commands`. A bare `two commands` is NOT a claim about the surface
// ("wire two commands into the setup script"), so `commands` needs kit's possessive or
// `top-level` before it, or a tier word. Approximations (`~80`, `about 80`, `over 80`)
// and subsets (`these two`, `the first three`) are skipped: their tolerance is not
// written down, and a gate that cries wolf is worse than none (see self-audit-docs.ts).
// A line can opt out with `kit-self-audit: allow-count` — for history told on purpose.
//
// Already pinned elsewhere, so not read here: docs/CLI_STABILITY.md's "N commands are
// `stable` and N are `experimental`" and the two "all N commands" claims held by
// src/command-surface.test.ts.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { SecurityCheckResult } from "./check-security.js";

const CATEGORY: SecurityCheckResult["category"] = "self-audit/count-claims";
const ALLOW_MARKER = "kit-self-audit: allow-count";

export type CountKind =
  "adrs" | "self-audit-rules" | "runtime-deps" | "commands" | "stable" | "experimental";
export type CountOracle = Partial<Record<CountKind, number>>;

const UNITS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
const TEENS = [
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

/** "27", "nine", "Twenty-seven", "twenty seven" → number; anything else → null. */
export function parseCount(token: string): number | null {
  const t = token.trim().toLowerCase().replace(/\s+/g, "-");
  if (/^\d+$/.test(t)) return Number(t);
  if (UNITS.includes(t)) return UNITS.indexOf(t);
  if (TEENS.includes(t)) return 10 + TEENS.indexOf(t);
  const [tens, unit] = t.split("-");
  const ti = TENS.indexOf(tens);
  if (ti < 2) return null;
  if (unit === undefined) return ti * 10;
  const ui = UNITS.indexOf(unit);
  return ui > 0 ? ti * 10 + ui : null;
}

const WORD = `(?:${[...TENS.slice(2)].join("|")})(?:[- ](?:${UNITS.slice(1).join("|")}))?|${[...TEENS, ...UNITS].join("|")}`;
const NUM = `(\\d+|${WORD})`;
// The word before the number: approximations and subsets make the number not a total.
const HEDGE =
  /(?:~|\b(?:about|around|roughly|approximately|nearly|almost|over|under|than|least|most|up\s+to|these|those|following|first|last|next|other|another|some)\s*)$/i;

interface ClaimPattern {
  kind: CountKind | "tier";
  re: RegExp;
}

const PATTERNS: ClaimPattern[] = [
  {
    kind: "adrs",
    re: new RegExp(
      `\\b${NUM}\\s+(?:ADRs|architecture\\s+decision\\s+records|architecture\\s+decisions)\\b`,
      "gi",
    ),
  },
  {
    kind: "self-audit-rules",
    re: new RegExp(`\\b${NUM}\\s+(?:self-hardening|self-audit)\\s+rules\\b`, "gi"),
  },
  {
    kind: "runtime-deps",
    re: new RegExp(
      `\\b${NUM}\\s+(?:direct\\s+)?(?:runtime|production)\\s+(?:deps|dependencies)\\b`,
      "gi",
    ),
  },
  {
    kind: "commands",
    re: new RegExp(
      `\\bkit(?:'s|\\s+has|\\s+ships|\\s+exposes)\\s+${NUM}\\s+(?:top-level\\s+)?commands\\b`,
      "gi",
    ),
  },
  { kind: "commands", re: new RegExp(`\\b${NUM}\\s+top-level\\s+commands\\b`, "gi") },
  { kind: "tier", re: new RegExp(`\\b${NUM}\\s+(stable|experimental)\\s+commands\\b`, "gi") },
];

export interface CountClaim {
  file: string;
  line: number;
  kind: CountKind;
  stated: number;
  text: string;
}

function lineClaims(line: string): Omit<CountClaim, "file" | "line">[] {
  const out: Omit<CountClaim, "file" | "line">[] = [];
  const ends = new Set<number>(); // two phrasings can match one claim ("kit has 80 top-level commands")
  for (const p of PATTERNS) {
    for (const m of line.matchAll(p.re)) {
      const end = (m.index ?? 0) + m[0].length;
      const stated = parseCount(m[1]);
      if (stated === null || ends.has(end) || HEDGE.test(line.slice(0, m.index))) continue;
      ends.add(end);
      const kind = p.kind === "tier" ? (m[2].toLowerCase() as CountKind) : p.kind;
      out.push({ kind, stated, text: m[0] });
    }
  }
  return out;
}

/** Every countable claim in one document. */
export function extractCountClaims(text: string, file: string): CountClaim[] {
  return text
    .split("\n")
    .flatMap((line, i) =>
      line.includes(ALLOW_MARKER) ? [] : lineClaims(line).map((c) => ({ file, line: i + 1, ...c })),
    );
}

/**
 * README.md, CLAUDE.md, AGENTS.md, docs/*.md and the generated command contract (whose
 * summaries are `kit help`, where "12 self-hardening rules" sat) that exist.
 */
function countClaimDocs(repoRoot: string): string[] {
  const docs = ["README.md", "CLAUDE.md", "AGENTS.md", "contracts/kit.opencli.json"];
  try {
    for (const name of readdirSync(join(repoRoot, "docs")).sort()) {
      if (name.endsWith(".md")) docs.push(`docs/${name}`);
    }
  } catch {
    // no docs/ — the root files are still read
  }
  return docs.filter((d) => readOrNull(join(repoRoot, d)) !== null);
}

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function readJson(path: string): Record<string, unknown> | null {
  const raw = readOrNull(path);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Count each set from its source of truth. A set whose source is missing has no count. */
export function loadCountOracle(repoRoot: string, selfAuditRules: number): CountOracle {
  const oracle: CountOracle = { "self-audit-rules": selfAuditRules };
  try {
    oracle.adrs = readdirSync(join(repoRoot, "docs", "adr")).filter((n) =>
      /^\d{4}-.+\.md$/.test(n),
    ).length;
  } catch {
    // no docs/adr — ADR claims go unchecked
  }
  const deps = readJson(join(repoRoot, "package.json"))?.dependencies;
  if (deps && typeof deps === "object") oracle["runtime-deps"] = Object.keys(deps).length;
  const commands = readJson(join(repoRoot, "contracts", "kit.opencli.json"))?.commands;
  if (commands && typeof commands === "object") {
    const tiers = Object.values(commands as Record<string, { "x-kit-stability"?: string }>).map(
      (c) => c?.["x-kit-stability"],
    );
    oracle.commands = tiers.length;
    oracle.stable = tiers.filter((t) => t === "stable").length;
    oracle.experimental = tiers.filter((t) => t === "experimental").length;
  }
  return oracle;
}

export interface CountMismatch extends CountClaim {
  actual: number;
}

export function analyzeCountClaims(repoRoot: string, selfAuditRules: number): CountMismatch[] {
  const oracle = loadCountOracle(repoRoot, selfAuditRules);
  const out: CountMismatch[] = [];
  for (const doc of countClaimDocs(repoRoot)) {
    const text = readOrNull(join(repoRoot, doc)) ?? "";
    for (const claim of extractCountClaims(text, doc)) {
      const actual = oracle[claim.kind];
      if (actual !== undefined && actual !== claim.stated) out.push({ ...claim, actual });
    }
  }
  return out;
}

const SOURCE: Record<CountKind, string> = {
  adrs: "docs/adr",
  "self-audit-rules": "the self-audit rule table",
  "runtime-deps": "package.json dependencies",
  commands: "contracts/kit.opencli.json",
  stable: "contracts/kit.opencli.json",
  experimental: "contracts/kit.opencli.json",
};

export function runCountClaimsAudit(
  repoRoot: string,
  selfAuditRules: number,
): SecurityCheckResult[] {
  const mismatches = analyzeCountClaims(repoRoot, selfAuditRules);
  if (mismatches.length === 0) {
    return [
      {
        category: CATEGORY,
        name: "count claims",
        status: "pass",
        detail:
          "every count kit's docs state about its own ADRs, rules, runtime deps and commands matches its source",
      },
    ];
  }
  return mismatches.map((m) => ({
    category: CATEGORY,
    name: "count claims",
    status: "fail" as const,
    severity: "high" as const,
    detail: `"${m.text}" states ${m.stated}; ${SOURCE[m.kind]} has ${m.actual}`,
    files: [`${m.file}:${m.line}`],
    suggestion: `write ${m.actual}, or drop the number and point at the source (a stated count drifts)`,
  }));
}
