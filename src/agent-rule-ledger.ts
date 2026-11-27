/**
 * The agent rule ledger: one row per saved allow, ask or deny rule, across harnesses and scopes,
 * with a class and the date kit first saw it, plus a baseline that reports what changed.
 *
 * kit-research `prismor-always-allowed-rules-vs-kit`: a reply to a permission prompt can add allow
 * rules and remove deny rules in a settings file (Claude Code's `updatedPermissions`), and the
 * change outlives whoever sent it. `kit agent-audit` read Claude Code's allow rules only as
 * trifecta legs, never listed one, read no Codex, Cursor or Gemini rule, and removing five of kit's
 * own deny rules changed no row. Now:
 *
 *   - every rule is listed with harness, scope, file, rule, kind, class and first-seen date;
 *   - the class comes from the trifecta's own tables (`grantClass`), not from a new regex score;
 *   - `~/.kit/agent-rules.json` records the accepted rules. A new allow rule and a removed deny or
 *     ask rule are reported on every run until a person runs `kit agent-audit --accept-rules`,
 *     which the gates refuse from an agent (trail-guard), as they do `--accept-user-surfaces`;
 *   - a rule kit cannot parse is reported, never counted as narrow.
 *
 * Agents keep no dates in their rule files, so "first seen" is the first run of kit that saw the
 * rule. Read-only: nothing is written outside `~/.kit`, and nothing there in read-only mode.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { grantClass, shown } from "./agent-trifecta.js";
import {
  collectRules,
  NOT_COVERED,
  type Harness,
  type Kind,
  type Scope,
} from "./agent-rule-sources.js";
import type { SecurityCheckResult } from "./check-security.js";

export interface LedgerRow {
  harness: Harness;
  scope: Scope;
  file: string;
  rule: string;
  kind: Kind;
  class: string;
  firstSeen: string;
}

export interface Ledger {
  rows: LedgerRow[];
  results: SecurityCheckResult[];
  read: Harness[];
  notCovered: string[];
}

/** The acceptance flag, read by `kit agent-audit` only (its flag contract lists it). */
export const ACCEPT_RULES_FLAG = "--accept-rules";
const ACCEPT = `kit agent-audit ${ACCEPT_RULES_FLAG}`;
const HARNESSES: Harness[] = ["Claude Code", "Codex", "Cursor CLI", "Gemini CLI"];

export function ruleBaselinePath(home: string): string {
  return join(home, ".kit", "agent-rules.json");
}

interface Baseline {
  accepted: string[] | null;
  seen: Record<string, string>;
}

function keyOf(r: Pick<LedgerRow, "harness" | "scope" | "file" | "kind" | "rule">): string {
  return JSON.stringify([r.harness, r.scope, r.file, r.kind, r.rule]);
}

function readBaseline(home: string): Baseline {
  try {
    const v = JSON.parse(readFileSync(ruleBaselinePath(home), "utf-8")) as Partial<Baseline>;
    const accepted = Array.isArray(v.accepted)
      ? v.accepted.filter((k): k is string => typeof k === "string")
      : null;
    const seen = v.seen && typeof v.seen === "object" ? v.seen : {};
    return { accepted, seen };
  } catch {
    return { accepted: null, seen: {} };
  }
}

function writeBaseline(home: string, b: { accepted: string[]; seen: Record<string, string> }) {
  const path = ruleBaselinePath(home);
  mkdirSync(dirname(path), { recursive: true });
  const body = JSON.stringify({ version: 1, ...b }, null, 2) + "\n";
  writeFileSync(path, body, { encoding: "utf-8", mode: 0o600 });
}

interface Opts {
  record: boolean;
  today?: string;
  platform?: NodeJS.Platform;
  managedDirs?: string[];
}

function rowsOf(root: string, home: string, env: Record<string, unknown>, o: Opts) {
  return collectRules({
    root,
    home,
    env,
    platform: o.platform ?? process.platform,
    managedDirs: o.managedDirs,
  }).map((r) => {
    const base = r.kind === "unparsed" ? "unparsed" : grantClass(r.grants);
    const cls = r.unsandboxed ? `${base}, unsandboxed` : base;
    return {
      harness: r.harness,
      scope: r.scope,
      file: shown(r.file),
      rule: shown(r.rule),
      kind: r.kind,
      class: cls,
    };
  });
}

function where(r: Pick<LedgerRow, "harness" | "file" | "rule">): string {
  return `${r.harness} ${r.file}: ${r.rule}`;
}

function listed(items: string[]): string {
  const more = items.length > 5 ? ` and ${items.length - 5} more` : "";
  return items.slice(0, 5).join("; ") + more;
}

function parsedFromKey(k: string): Pick<LedgerRow, "harness" | "file" | "kind" | "rule"> | null {
  try {
    const [harness, , file, kind, rule] = JSON.parse(k) as string[];
    return { harness: harness as Harness, file, kind: kind as Kind, rule };
  } catch {
    return null;
  }
}

const NAME = "agent rules since last accepted";

function driftResults(rows: LedgerRow[], accepted: string[]): SecurityCheckResult[] {
  const before = new Set(accepted);
  const now = new Set(rows.map(keyOf));
  const added = rows.filter((r) => r.kind === "allow" && !before.has(keyOf(r)));
  const removed = accepted
    .filter((k) => !now.has(k))
    .map(parsedFromKey)
    .filter(
      (r): r is NonNullable<typeof r> => r !== null && (r.kind === "deny" || r.kind === "ask"),
    );
  const out: SecurityCheckResult[] = [];
  if (removed.length) {
    out.push({
      category: "exposure",
      name: `${NAME}: deny or ask rules removed`,
      status: "warn",
      severity: "high",
      hasFindings: true,
      detail: `${removed.length} rule(s) that blocked or prompted are gone: ${listed(removed.map((r) => `${r.kind} ${where(r)}`))}`,
      suggestion: `a permission reply or an agent's edit can remove them; restore them, or if you removed them yourself run \`${ACCEPT}\``,
    });
  }
  if (added.length) {
    out.push({
      category: "exposure",
      name: `${NAME}: new allow rules`,
      status: "warn",
      severity: "medium",
      hasFindings: true,
      detail: `${added.length} allow rule(s) not in the accepted baseline: ${listed(added.map((r) => `${where(r)} [${r.class}]`))}`,
      suggestion: `read them; if you added or expected them, run \`${ACCEPT}\` yourself`,
    });
  }
  return out;
}

function findingResults(rows: LedgerRow[]): SecurityCheckResult[] {
  const out: SecurityCheckResult[] = [];
  const bad = rows.filter((r) => r.kind === "unparsed");
  if (bad.length) {
    out.push({
      category: "exposure",
      name: "agent rules: unparsed",
      status: "warn",
      severity: "medium",
      hasFindings: true,
      detail: `kit could not read ${bad.length} rule(s) or file(s), so it counts none of them as narrow: ${listed(bad.map(where))}`,
      suggestion: "check these by hand; kit reads rule files as text and never evaluates them",
    });
  }
  const wide = rows.filter(
    (r) =>
      r.kind === "allow" && r.harness !== "Claude Code" && r.class.startsWith("all three legs"),
  );
  if (wide.length) {
    out.push({
      category: "exposure",
      name: "agent rules: allow rules that hold all three legs",
      status: "warn",
      severity: "medium",
      hasFindings: true,
      detail: `${listed(wide.map(where))}. Each runs code the agent chooses without a prompt, like an unrestricted Bash`,
      suggestion: "narrow the rule to the exact command, or make it prompt",
    });
  }
  return out;
}

function baselineResults(rows: LedgerRow[], b: Baseline, o: Opts): SecurityCheckResult[] {
  if (b.accepted !== null) return driftResults(rows, b.accepted);
  if (!o.record) {
    return [
      {
        category: "exposure",
        name: NAME,
        status: "skip",
        detail: "no baseline yet, and read-only mode writes none",
      },
    ];
  }
  return [
    {
      category: "exposure",
      name: NAME,
      status: "pass",
      detail: `baseline recorded for ${rows.length} rule(s); new allow rules and removed deny or ask rules are reported until \`${ACCEPT}\``,
    },
  ];
}

/** The ledger rows and its findings. Records first-seen dates and the first baseline when allowed. */
export function runRuleLedger(
  root: string,
  home: string,
  env: Record<string, unknown>,
  o: Opts,
): Ledger {
  const today = o.today ?? new Date().toISOString().slice(0, 10);
  const b = readBaseline(home);
  const plain = rowsOf(root, home, env, o);
  const seen = { ...b.seen };
  let fresh = false;
  for (const r of plain) {
    if (!(keyOf(r) in seen)) {
      seen[keyOf(r)] = today;
      fresh = true;
    }
  }
  const rows = plain.map((r) => ({ ...r, firstSeen: seen[keyOf(r)] }));
  const results = [...findingResults(rows), ...baselineResults(rows, b, o)];
  if (o.record && (fresh || b.accepted === null)) {
    writeBaseline(home, { accepted: b.accepted ?? rows.map(keyOf), seen });
  }
  const clean = results.every((r) => r.status === "pass" || r.status === "skip");
  if (clean && b.accepted !== null) {
    results.push({
      category: "exposure",
      name: NAME,
      status: "pass",
      detail: `${rows.length} rule(s), none added or removed since accepted`,
    });
  }
  return { rows, results, read: HARNESSES, notCovered: NOT_COVERED };
}

/** Record the current rules as accepted. Returns how many. */
export function acceptRules(root: string, home: string, env: Record<string, unknown>): number {
  const b = readBaseline(home);
  const today = new Date().toISOString().slice(0, 10);
  const rows = rowsOf(root, home, env, { record: true });
  const seen = { ...b.seen };
  for (const r of rows) seen[keyOf(r)] ??= today;
  writeBaseline(home, { accepted: rows.map(keyOf), seen });
  return rows.length;
}

/** The ledger as text lines for `kit agent-audit`. Pure. */
export function ledgerLines(l: Ledger): string[] {
  const head = `agent rules (${l.rows.length}) read from ${l.read.join(", ")}`;
  const lines = [head];
  for (const r of l.rows) {
    lines.push(
      `  ${r.kind.padEnd(8)} ${r.harness.padEnd(11)} ${r.scope.padEnd(7)} ${r.file}  ${r.rule}  [${r.class}]  first seen ${r.firstSeen}`,
    );
  }
  lines.push(`not covered: ${l.notCovered.join(", ")}`);
  return lines;
}
