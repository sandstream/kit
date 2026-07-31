// Class 14 analyzer for `kit self-audit`: documented-command integrity.
//
// kit's docs tell humans AND agents which commands to run. When a command is
// renamed or dropped but a doc still names it, the reader gets
// `Unknown command: <verb>` — and an agent following CLAUDE.md has no way to tell
// a stale instruction from a live one. That is the same failure class as R11 (a
// workflow pointing at a moved script), one surface out: a claim about kit that
// kit does not honour.
//
// The oracle is `contracts/kit.opencli.json` — the committed, generated command
// contract. Reading it (rather than importing COMMAND_REGISTRY from cli.ts) keeps
// this analyzer a leaf: cli.ts dispatches `self-audit`, so an import back would be
// a module cycle.
//
// Pure + deterministic: no network, no LLM. extractDocCommandRefs/docExemption are
// the testable units; runDocsCommandAudit is the filesystem-bound orchestrator.
//
// Known limitation, found by this rule firing on the fix for its own first finding:
// a doc cannot state that a command does NOT exist while writing it in command form
// — `kit foo` in a code span is indistinguishable from an instruction to run it.
// Name the bare verb instead (`foo`), or put the note in an exempt document. This is
// deliberate: an escape hatch that suppresses per line would also suppress real
// drift, and the rule is only worth having if it cannot be waved through.
//
// Scope, stated so a pass is not over-read: this validates the *verb* only. Flags
// (`kit check --nonexistent`) and config keys claimed in TOML blocks are NOT checked,
// and kit's own commands ignore unknown flags rather than rejecting them — so a
// documented flag that does nothing still reads as working. A pass here means
// "every documented command exists", nothing wider.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { SecurityCheckResult } from "./check-security.js";

/** Category used for every result this analyzer emits. */
const DOCS_CATEGORY: SecurityCheckResult["category"] = "self-audit/docs-command-drift";

/** The committed command contract, relative to repoRoot. */
const CONTRACT_PATH = "contracts/kit.opencli.json";

export interface DocCommandRef {
  /** The verb immediately after `kit` — what gets resolved against the contract. */
  verb: string;
  /** 1-based line in the source markdown. */
  line: number;
  /** Repo-relative posix path of the markdown file. */
  file: string;
}

// A `kit <verb>` occurrence in command position: at the start of a code span/line,
// after a shell prompt, or after a `&&` / `|` chain operator. Anchoring this way is
// what separates a real invocation from English prose — an unanchored scan matches
// "kit is", "kit does", "kit ships" and drowns the signal (193 hits vs 6).
const CMD_RE = /(?:^|\$\s|&&\s|\|\s)\s*(?:npx\s+)?kit\s+([a-z][a-z0-9-]{1,30})/g;

// A captured verb that is a placeholder, not a command. Docs legitimately write
// `kit <command>` / `kit [cmd]` / `kit $VERB`; the leading-char classes in CMD_RE
// already exclude most, this catches the rest.
const PLACEHOLDER = new Set(["command", "cmd", "verb", "subcommand", "args"]);

/**
 * Real commands that the OpenCLI contract does not list, because `main()`
 * special-cases them before the dispatch table and the contract is generated from
 * `Object.keys(COMMANDS)`. `kit version` and `kit completions` both run; omitting
 * them here would make this rule report true documentation as drift.
 *
 * Same list, same reason, as the exemption in command-surface.test.ts. It is
 * hardcoded, so self-audit-docs.test.ts asserts it against the live surface —
 * a constant guarding against drift must not be allowed to drift itself.
 */
export const PRE_DISPATCH_VERBS = ["help", "version", "completions"] as const;

/**
 * Paths whose `kit <verb>` references are NOT drift, with the reason. These are
 * documents that legitimately name commands kit does not currently dispatch:
 *
 * - `CHANGELOG.md` — a historical record. An entry describing a command that was
 *   later removed is accurate about the past and must not be rewritten.
 * - `ROADMAP.md` — planned surface by definition.
 * - `docs/specs/**` — design documents for features that may never be built.
 *
 * Returns the reason string when exempt, or null when the file is in scope.
 */
export function docExemption(relPath: string): string | null {
  if (relPath === "CHANGELOG.md") return "historical record";
  if (relPath === "ROADMAP.md") return "planned surface";
  if (relPath.startsWith("docs/specs/")) return "design document";
  return null;
}

/**
 * Extract `kit <verb>` references from a markdown document, restricted to command
 * contexts: fenced code blocks and inline code spans. Prose is deliberately not
 * scanned — "kit enforces X" is a sentence, not an invocation.
 *
 * Line numbers are 1-based and point at the line the reference appears on, so a
 * finding is directly navigable.
 */
export function extractDocCommandRefs(markdownText: string, file: string): DocCommandRef[] {
  const refs: DocCommandRef[] = [];
  const lines = markdownText.split("\n");
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // A fence toggles block state and is never itself scanned (```bash etc).
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }

    // Inside a fence the whole line is code. Outside it, only backticked spans are.
    const spans = inFence ? [line] : [...line.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);

    for (const span of spans) {
      for (const m of span.matchAll(CMD_RE)) {
        const verb = m[1];
        if (PLACEHOLDER.has(verb)) continue;
        refs.push({ verb, line: i + 1, file });
      }
    }
  }

  return refs;
}

/**
 * Read the dispatched command verbs out of the committed OpenCLI contract.
 * Returns null when the contract is absent or unparsable — the caller must treat
 * that as "could not verify", never as "clean".
 */
export function loadContractVerbs(repoRoot: string): Set<string> | null {
  try {
    const raw = readFileSync(join(repoRoot, CONTRACT_PATH), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    const commands = (parsed as { commands?: unknown })?.commands;
    if (!commands || typeof commands !== "object") return null;
    const verbs = Object.keys(commands as Record<string, unknown>);
    if (verbs.length === 0) return null;
    return new Set([...verbs, ...PRE_DISPATCH_VERBS]);
  } catch {
    return null;
  }
}

// Subtrees a markdown walk never needs to enter.
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage", ".next", "tmp"]);

/** Collect repo-relative paths of every markdown file under `repoRoot`. */
function findMarkdownFiles(repoRoot: string): string[] {
  const out: string[] = [];
  function visit(dir: string, rel: string): void {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        // Dotdirs are skipped except .github, which carries real runbook docs.
        if (e.name.startsWith(".") && e.name !== ".github") continue;
        visit(join(dir, e.name), childRel);
        continue;
      }
      if (e.isFile() && e.name.endsWith(".md")) out.push(childRel);
    }
  }
  visit(repoRoot, "");
  return out;
}

/**
 * Resolve every documented `kit <verb>` against the command contract.
 *
 * A reference to a verb the contract does not declare is an `error` finding: the
 * doc instructs a reader to run something that does not exist. Exempt documents
 * (see `docExemption`) are skipped and counted, so the pass line states what was
 * actually verified rather than implying full coverage.
 */
export function runDocsCommandAudit(repoRoot: string): SecurityCheckResult[] {
  const verbs = loadContractVerbs(repoRoot);
  if (!verbs) {
    // Cannot verify => not clean. didNotRun makes the CI gate fail this by default.
    return [
      {
        category: DOCS_CATEGORY,
        name: "documented commands",
        status: "warn",
        severity: "medium",
        detail: `${CONTRACT_PATH} missing or unparsable — documented commands NOT verified`,
        didNotRun: true,
        suggestion: `regenerate the contract (npm run build) so doc drift can be checked`,
      },
    ];
  }

  const files = findMarkdownFiles(repoRoot);
  const unknown: DocCommandRef[] = [];
  let checkedRefs = 0;
  let checkedFiles = 0;
  let exemptFiles = 0;

  for (const file of files) {
    if (docExemption(file)) {
      exemptFiles++;
      continue;
    }
    let text;
    try {
      text = readFileSync(join(repoRoot, file), "utf-8");
    } catch {
      continue;
    }
    checkedFiles++;
    for (const ref of extractDocCommandRefs(text, file)) {
      checkedRefs++;
      if (!verbs.has(ref.verb)) unknown.push(ref);
    }
  }

  if (unknown.length === 0) {
    return [
      {
        category: DOCS_CATEGORY,
        name: "documented commands",
        status: "pass",
        detail:
          `${checkedRefs} \`kit <command>\` ref(s) across ${checkedFiles} doc(s) all resolve ` +
          `against ${verbs.size} known commands (${exemptFiles} doc(s) exempt)`,
      },
    ];
  }

  return [
    {
      category: DOCS_CATEGORY,
      name: "documented commands",
      status: "fail",
      severity: "medium",
      detail:
        `${unknown.length} documented command ref(s) do not exist: ` +
        unknown
          .slice(0, 6)
          .map((u) => `kit ${u.verb} (${u.file}:${u.line})`)
          .join(", "),
      files: [...new Set(unknown.map((u) => u.file))],
      suggestion: `fix the doc, or add the command — a doc naming a non-existent command misleads humans and agents alike`,
    },
  ];
}
