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
// Three claim classes are checked, each against a sound oracle:
//
//   commands  → contracts/kit.opencli.json (the committed command contract)
//   flags     → every `--flag` literal appearing in src/**.ts. kit parses argv by
//               naming each flag literally (`flagValue(args, "--x")`), so a flag the
//               implementation never names cannot possibly be read.
//   sections  → config.ts KNOWN_SECTIONS, the explicit set kit validates .kit.toml
//               against.
//
// Deliberately NOT checked: individual TOML *keys*. `ServiceConfig` carries an index
// signature (`[key: string]: string | undefined`), so user-defined keys under
// `[services.*]` are legal by design and never appear in source — an oracle over
// source text produces false positives there (it flagged README's `project_ref`,
// which is correct usage). A gate that cries wolf is worse than no gate, so key
// checking is left out rather than shipped unsound.
//
// Known scope limit that remains: the flag check is repo-global, not per-command. A
// real flag documented on the wrong command still passes, because kit's commands
// ignore unknown flags rather than rejecting them — `kit check --profile` runs and
// silently does nothing (`--profile` belongs to `bootstrap`). Catching that needs
// per-command flag ownership, which the source does not currently declare.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { SecurityCheckResult } from "./check-security.js";
import { KNOWN_SECTIONS } from "./config.js";

/** Category used for every result this analyzer emits. */
const DOCS_CATEGORY: SecurityCheckResult["category"] = "self-audit/docs-claims";

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
 * Extract flags documented on a `kit …` invocation. Only spans that actually invoke
 * kit are scanned, so a bare `--verbose` in prose about some other tool is ignored.
 * `--flag=value` is normalised to `--flag`.
 */
export function extractDocFlagRefs(markdownText: string, file: string): DocCommandRef[] {
  const refs: DocCommandRef[] = [];
  const lines = markdownText.split("\n");
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    const spans = inFence ? [line] : [...line.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
    for (const span of spans) {
      if (!/(?:^|\$\s|&&\s)\s*(?:npx\s+)?kit\s/.test(span)) continue;
      for (const m of span.matchAll(/\s(--[a-z][a-z0-9-]{1,30})/g)) {
        refs.push({ verb: m[1], line: i + 1, file });
      }
    }
  }
  return refs;
}

/** How far back to look for the prose that says which TOML file a fence shows. */
const ATTRIBUTION_LOOKBEHIND = 3;

/**
 * Extract `[section]` headers from ```toml fences that document **`.kit.toml`**.
 * Sub-sections are reduced to their top-level parent (`[services.supabase]` →
 * `services`), the granularity KNOWN_SECTIONS validates.
 *
 * Attribution matters: kit reads more than one TOML schema. `docs/POLICY.md` shows a
 * *policy* file with `[thresholds]`, which is correct there and unknown to
 * `.kit.toml`. So a fence is only checked when `.kit.toml` is named either inside it
 * (`# .kit.toml`) or in the few lines of prose introducing it. An unattributed fence
 * is skipped rather than guessed at — the alternative is a gate that fires on correct
 * documentation of a different file.
 */
export function extractDocTomlSections(markdownText: string, file: string): DocCommandRef[] {
  const refs: DocCommandRef[] = [];
  const lines = markdownText.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const fence = lines[i].match(/^\s*```(\w*)/);
    if (!fence || fence[1] !== "toml") continue;

    // Body of this fence.
    let end = i + 1;
    while (end < lines.length && !/^\s*```/.test(lines[end])) end++;
    const body = lines.slice(i + 1, end);

    const intro = lines.slice(Math.max(0, i - ATTRIBUTION_LOOKBEHIND), i).join("\n");
    const attributed = body.some((l) => l.includes(".kit.toml")) || intro.includes(".kit.toml");

    if (attributed) {
      for (let j = 0; j < body.length; j++) {
        const m = body[j].match(/^\s*\[\[?([a-z][a-z0-9_]*)/);
        if (m) refs.push({ verb: m[1], line: i + 2 + j, file });
      }
    }
    i = end;
  }
  return refs;
}

/**
 * Collect every flag-shaped literal appearing anywhere in `src/**.ts`. This is the
 * flag oracle: kit reads argv by naming flags literally, so a flag absent from
 * source cannot be read by any command.
 */
export function loadSourceFlagTokens(repoRoot: string): Set<string> {
  const flags = new Set<string>();
  function visit(dir: string): void {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
        visit(join(dir, e.name));
        continue;
      }
      if (!e.name.endsWith(".ts")) continue;
      let text;
      try {
        text = readFileSync(join(dir, e.name), "utf-8");
      } catch {
        continue;
      }
      for (const m of text.matchAll(/--[a-z][a-z0-9-]{1,30}/g)) flags.add(m[0]);
    }
  }
  visit(join(repoRoot, "src"));
  return flags;
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

/** One claim class: how to pull it out of a doc, and what it must resolve against. */
interface ClaimClass {
  /** Result name, e.g. "documented commands". */
  name: string;
  /** Noun used in both the pass and fail lines. */
  unit: string;
  extract: (text: string, file: string) => DocCommandRef[];
  /** How a finding is rendered, so `kit foo` and `--foo` read naturally. */
  render: (verb: string) => string;
}

const CLAIM_CLASSES: ClaimClass[] = [
  {
    name: "documented commands",
    unit: "`kit <command>`",
    extract: extractDocCommandRefs,
    render: (v) => `kit ${v}`,
  },
  {
    name: "documented flags",
    unit: "`kit … --flag`",
    extract: extractDocFlagRefs,
    render: (v) => v,
  },
  {
    name: "documented config sections",
    unit: "`[section]`",
    extract: extractDocTomlSections,
    render: (v) => `[${v}]`,
  },
];

/**
 * Resolve every claim kit's docs make about its own surface against a machine
 * oracle: commands against the committed contract, flags against the flag literals
 * the implementation names, `[section]` headers against KNOWN_SECTIONS.
 *
 * A claim that does not resolve is a `fail`: the doc instructs a reader to use
 * something that does not exist. Exempt documents (see `docExemption`) are skipped
 * and counted, so a pass line states what was actually verified rather than implying
 * full coverage.
 */
export function runDocsClaimsAudit(repoRoot: string): SecurityCheckResult[] {
  const verbs = loadContractVerbs(repoRoot);
  if (!verbs) {
    // Cannot verify => not clean. didNotRun makes the CI gate fail this by default.
    return [
      {
        category: DOCS_CATEGORY,
        name: "documented commands",
        status: "warn",
        severity: "medium",
        detail: `${CONTRACT_PATH} missing or unparsable — documented claims NOT verified`,
        didNotRun: true,
        suggestion: `regenerate the contract (npm run build) so doc drift can be checked`,
      },
    ];
  }

  const oracles: Record<string, Set<string>> = {
    "documented commands": verbs,
    "documented flags": loadSourceFlagTokens(repoRoot),
    "documented config sections": new Set(KNOWN_SECTIONS),
  };

  const files = findMarkdownFiles(repoRoot);
  const inScope: { file: string; text: string }[] = [];
  let exemptFiles = 0;

  for (const file of files) {
    if (docExemption(file)) {
      exemptFiles++;
      continue;
    }
    try {
      inScope.push({ file, text: readFileSync(join(repoRoot, file), "utf-8") });
    } catch {
      continue;
    }
  }

  return CLAIM_CLASSES.map((cls) => {
    const oracle = oracles[cls.name];
    const unknown: DocCommandRef[] = [];
    let checked = 0;

    for (const { file, text } of inScope) {
      for (const ref of cls.extract(text, file)) {
        checked++;
        if (!oracle.has(ref.verb)) unknown.push(ref);
      }
    }

    if (unknown.length === 0) {
      return {
        category: DOCS_CATEGORY,
        name: cls.name,
        status: "pass",
        detail:
          `${checked} ${cls.unit} ref(s) across ${inScope.length} doc(s) all resolve ` +
          `against ${oracle.size} known (${exemptFiles} doc(s) exempt)`,
      };
    }

    return {
      category: DOCS_CATEGORY,
      name: cls.name,
      status: "fail",
      severity: "medium",
      detail:
        `${unknown.length} of ${checked} ${cls.unit} ref(s) do not exist: ` +
        unknown
          .slice(0, 6)
          .map((u) => `${cls.render(u.verb)} (${u.file}:${u.line})`)
          .join(", "),
      files: [...new Set(unknown.map((u) => u.file))],
      suggestion: `fix the doc, or implement it — a doc naming something kit does not have misleads humans and agents alike`,
    };
  });
}
