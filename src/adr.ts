/**
 * kit — ADR → gate. Turn the machine-readable part of an Architecture Decision
 * Record into a deterministic gate, cited back to the ADR ("why is this blocked?
 * → ADR-0007"). Design: kit-research/docs/research/adr-as-enforced-rule-design.md.
 *
 * kit does NOT interpret ADR prose (that needs an LLM — off-charter). It enforces
 * only an explicit ` ```toml kit-enforce ` block (parsed with the same smol-toml as
 * .kit.toml). Only `status: accepted` ADRs enforce; an accepted ADR with no enforce
 * block is surfaced as "documented, not enforced" — never silently green.
 *
 * Pure + deterministic: parse/evaluate are functions of their text inputs (no I/O).
 */
import { parse as parseToml } from "smol-toml";

export type AdrStatus = "proposed" | "accepted" | "superseded" | "deprecated" | "unknown";

/** A single deterministic enforce rule. Only forbid-pattern in the first increment. */
export interface AdrRule {
  type: "forbid-pattern";
  /** Regex source that must NOT appear in matching files. */
  pattern: string;
  /** Glob of files the rule applies to (minimatch-style). */
  paths: string;
  /** Optional human message shown on a violation. */
  message?: string;
}

export interface Adr {
  id: string;
  title: string;
  status: AdrStatus;
  rules: AdrRule[];
  /** True when a ```toml kit-enforce block was present (even if it parsed to zero rules). */
  hasEnforceBlock: boolean;
}

export interface AdrViolation {
  adrId: string;
  file: string;
  line: number;
  pattern: string;
  message: string;
}

const STATUSES: AdrStatus[] = ["proposed", "accepted", "superseded", "deprecated"];

function scalar(frontmatter: string, key: string): string | undefined {
  const m = frontmatter.match(new RegExp(`^${key}:(.*)$`, "mi"));
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : undefined;
}

/**
 * Parse an ADR markdown file. Returns null when it has no `---` frontmatter or no `id`
 * (not an ADR). Never throws — a malformed enforce block yields `hasEnforceBlock: true`
 * with zero rules (surfaced, not a crash).
 */
export function parseAdr(raw: string): Adr | null {
  const text = raw.replace(/\r\n/g, "\n");
  const fm = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!fm) return null;
  const [, frontmatter, body] = fm;
  const id = scalar(frontmatter, "id");
  if (!id) return null;
  const title = scalar(frontmatter, "title") ?? id;
  const rawStatus = (scalar(frontmatter, "status") ?? "unknown").toLowerCase();
  const status: AdrStatus = (STATUSES as string[]).includes(rawStatus)
    ? (rawStatus as AdrStatus)
    : "unknown";

  // A fenced ```toml kit-enforce block anywhere in the body.
  const block = body.match(/```toml\s+kit-enforce\s*\n([\s\S]*?)\n```/);
  let rules: AdrRule[] = [];
  const hasEnforceBlock = block !== null;
  if (block) {
    try {
      const parsed = parseToml(block[1]) as { forbid_pattern?: unknown };
      const list = Array.isArray(parsed.forbid_pattern) ? parsed.forbid_pattern : [];
      rules = list
        .map((r): AdrRule | null => {
          const o = r as Record<string, unknown>;
          if (typeof o.pattern !== "string" || typeof o.paths !== "string") return null;
          return {
            type: "forbid-pattern",
            pattern: o.pattern,
            paths: o.paths,
            message: typeof o.message === "string" ? o.message : undefined,
          };
        })
        .filter((r): r is AdrRule => r !== null);
    } catch {
      rules = []; // malformed TOML → zero rules, but hasEnforceBlock stays true (surfaced)
    }
  }
  return { id, title, status, rules, hasEnforceBlock };
}

/** An accepted ADR that actually carries at least one enforceable rule. */
export function adrIsEnforced(adr: Adr): boolean {
  return adr.status === "accepted" && adr.rules.length > 0;
}

/** Minimal glob → RegExp (supports `**`, `*`, `?`). Anchored full-match. Deterministic. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++; // `**/` matches zero or more dirs
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else if (".+^${}()|[]\\".includes(ch)) {
      re += "\\" + ch;
    } else {
      re += ch;
    }
  }
  return new RegExp(`^${re}$`);
}

/**
 * Evaluate an accepted ADR's forbid-pattern rules over the provided files. Pure — the caller
 * supplies `{ path, content }` for the repo; this never touches disk. A non-accepted ADR (or
 * one with no rules) yields no violations. Line numbers are 1-indexed on the first match.
 */
export function evaluateAdr(adr: Adr, files: { path: string; content: string }[]): AdrViolation[] {
  if (adr.status !== "accepted") return [];
  const violations: AdrViolation[] = [];
  for (const rule of adr.rules) {
    let matcher: RegExp;
    let globRe: RegExp;
    try {
      matcher = new RegExp(rule.pattern);
      globRe = globToRegExp(rule.paths);
    } catch {
      continue; // a malformed regex/glob rule is skipped, never a crash
    }
    for (const f of files) {
      if (!globRe.test(f.path)) continue;
      const lines = f.content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (matcher.test(lines[i])) {
          violations.push({
            adrId: adr.id,
            file: f.path,
            line: i + 1,
            pattern: rule.pattern,
            message: rule.message ?? `forbidden by ${adr.id}: /${rule.pattern}/`,
          });
          break; // one violation per (rule, file) is enough to gate
        }
      }
    }
  }
  return violations;
}
