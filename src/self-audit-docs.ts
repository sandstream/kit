// Class 14 analyzer for `kit self-audit`: documented-claim integrity.
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
// the testable units; runDocsClaimsAudit is the filesystem-bound orchestrator.
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
//   flags     → per-command `x-kit-accepted-flags` in contracts/kit.opencli.json.
//               That extension is generated from src/flag-surface.ts, the same table
//               dispatch uses to reject unknown flags.
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
// The OpenCLI standard `flags` array remains intentionally omitted until kit models
// flag types/arity. The namespaced accepted-flag list is narrower: it answers the
// enforcement question without fabricating metadata a code generator could misuse.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { SecurityCheckResult } from "./check-security.js";
import { KNOWN_SECTIONS } from "./config.js";

/** Category used for every result this analyzer emits. */
const DOCS_CATEGORY: SecurityCheckResult["category"] = "self-audit/docs-claims";

/** Own category so the advisory renderer can label the count meaningfully. */
const FLAG_VALIDATION_CATEGORY: SecurityCheckResult["category"] = "self-audit/flag-validation";

/**
 * `KIT_*` env vars a doc presents as a switch the reader sets, that no code branch
 * reads. Found the hard way: README, `doctor`'s own remediation hint and the NIST
 * 800-53 evidence map all told users to set `KIT_REQUIRE_HARDWARE` to make a missing
 * hardware key backend fail closed. The variable the implementation reads is
 * `KIT_REQUIRE_HARDWARE_IDENTITY`. Setting the documented one did nothing at all —
 * a silent false-secure in kit's own security surface, which is worse than a missing
 * feature because the user believes the control is on.
 *
 * The oracle is deliberately generous, to stay sound: a name counts as known if the
 * implementation reads it via `process.env.X`, via a destructured `env.X` (how
 * `airgap/config.ts` reads its vars), or sets it for a child process/hook. Only a
 * name the implementation never touches at all is reported.
 */
const ENV_READ_PATTERNS = [
  /process\.env\.([A-Z][A-Z0-9_]{2,60})/g,
  /process\.env\[["'`]([A-Z][A-Z0-9_]{2,60})/g,
  /\benv\.([A-Z][A-Z0-9_]{2,60})/g,
  /["'`](KIT_[A-Z0-9_]{2,60})["'`]\s*[:=,)\]]/g,
  /\b(KIT_[A-Z0-9_]{2,60})\s*[:=]/g,
];

/** Collect every `KIT_*` name the implementation reads or sets. */
export function loadKnownEnvVars(repoRoot: string): Set<string> {
  const known = new Set<string>();
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
      if (!e.name.endsWith(".ts") || e.name.endsWith(".test.ts")) continue;
      let text;
      try {
        text = readFileSync(join(dir, e.name), "utf-8");
      } catch {
        continue;
      }
      for (const re of ENV_READ_PATTERNS) {
        for (const m of text.matchAll(re)) known.add(m[1]);
      }
    }
  }
  visit(join(repoRoot, "src"));
  return known;
}

/**
 * Extract `KIT_*` env-var names a doc names. Scanned everywhere, not just code
 * spans: `export KIT_X=1` in a fence and "set `KIT_X`" in prose are the same claim
 * to a reader. A trailing-underscore capture (a `KIT_PROVENANCE_*` wildcard) is
 * dropped — it names a family, not a variable.
 */
export function extractDocEnvVars(markdownText: string, file: string): DocCommandRef[] {
  const refs: DocCommandRef[] = [];
  markdownText.split("\n").forEach((line, i) => {
    for (const m of line.matchAll(/\b(KIT_[A-Z0-9_]{2,60})\b/g)) {
      if (m[1].endsWith("_")) continue;
      refs.push({ verb: m[1], line: i + 1, file });
    }
  });
  return refs;
}

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

export interface DocFlagRef {
  /** The top-level command whose allowlist must contain this flag. */
  command: string;
  /** Normalised long flag name, e.g. `--json` from `--json=true`. */
  flag: string;
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

const DOC_GLOBAL_PREFIX_FLAGS = new Set([
  "--read-only",
  "--readonly",
  "--non-interactive",
  "--env",
]);

const KIT_INVOCATION_RE = /(?:^|\$\s|&&\s|\|\s)\s*(?:npx\s+)?kit\s+([^;&|`\n]+)/g;

function normaliseDocFlagToken(token: string): string | null {
  let clean = token.trim().replace(/^[[{(<]+/, "");
  if (clean === "--") return "--";
  const eq = clean.indexOf("=");
  if (eq >= 0) clean = clean.slice(0, eq);
  clean = clean.replace(/[\]),}>.:;]+$/g, "");
  return /^--[a-z][a-z0-9-]{1,30}$/.test(clean) ? clean : null;
}

function extractInvocationFlagRefs(invocation: string, line: number, file: string): DocFlagRef[] {
  const tokens = invocation.trim().split(/\s+/).filter(Boolean);
  const leadingFlags: string[] = [];
  let command: string | null = null;
  let commandIndex = -1;

  for (let i = 0; i < tokens.length; i++) {
    const flag = normaliseDocFlagToken(tokens[i]);
    if (flag === "--") return [];
    if (flag) {
      if (DOC_GLOBAL_PREFIX_FLAGS.has(flag)) {
        leadingFlags.push(flag);
        continue;
      }
      return [];
    }

    const word = tokens[i].replace(/^[[{(<]+/, "").replace(/[\]),}>.:;]+$/g, "");
    if (/^[a-z][a-z0-9-]{1,30}$/.test(word) && !PLACEHOLDER.has(word)) {
      command = word;
      commandIndex = i;
    }
    break;
  }

  if (!command) return [];

  const refs = leadingFlags.map((flag) => ({ command, flag, line, file }));
  for (const token of tokens.slice(commandIndex + 1)) {
    const flag = normaliseDocFlagToken(token);
    if (flag === "--") break;
    if (flag) refs.push({ command, flag, line, file });
  }
  return refs;
}

/**
 * Extract flags documented on a `kit …` invocation, attributed to the command that
 * owns the allowlist. Only spans that actually invoke kit are scanned, so a bare
 * `--verbose` in prose about some other tool is ignored. `--flag=value` is
 * normalised to `--flag`, and pass-through flags after `--` are left alone.
 */
export function extractDocFlagRefs(markdownText: string, file: string): DocFlagRef[] {
  const refs: DocFlagRef[] = [];
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
      for (const m of span.matchAll(KIT_INVOCATION_RE)) {
        refs.push(...extractInvocationFlagRefs(m[1], i + 1, file));
      }
    }
  }
  return refs;
}

/**
 * Command modules that validate argv against an allowlist, over the total. kit's
 * commands historically read the flags they knew and ignored the rest, which is how
 * `kit check --category` stayed a no-op while being documented in eight places
 * (including the CLAUDE.md kit generates into user projects).
 *
 * Reported as a tracked **warning**, not a fail: the honest state is that one command
 * validates and the rest do not, and each remaining module needs its true flag list
 * read off its own source before it can reject anything — getting that wrong breaks a
 * working invocation. Measuring it first is the same observe→enforce ladder kit uses
 * for runtime gates; the number can only go down, and now it is visible.
 */
/**
 * Flag-validation coverage, measured over VERBS against the declared flag surface.
 *
 * It used to grep `src/commands/*.ts` for the string `unknownFlags(`, which measured the
 * shape of the fix rather than the property: a module with many handlers could contain one
 * guard and leave its other verbs open, and two verbs (`fix`, `plugin`) do not live under
 * `src/commands` at all, so no amount of grepping there could see them.
 *
 * The property is "every command rejects flags it does not accept". Since the floor lives at
 * dispatch and reads `src/flag-surface.ts` (the same shape as the read-only floor reading
 * `read-only-surface.ts`), coverage is: every verb in COMMAND_REGISTRY has an entry in that
 * table. A verb without one is skipped by the floor — unvalidated, which is exactly what
 * this row must report.
 */
export function flagValidationCoverage(repoRoot: string): {
  validating: string[];
  missing: string[];
} {
  const validating: string[] = [];
  const missing: string[] = [];
  let cli: string;
  let surface: string;
  try {
    cli = readFileSync(join(repoRoot, "src", "cli.ts"), "utf-8");
  } catch {
    return { validating, missing };
  }
  try {
    surface = readFileSync(join(repoRoot, "src", "flag-surface.ts"), "utf-8");
  } catch {
    surface = "";
  }
  const tabled = new Set<string>();
  for (const m of surface.matchAll(/^ {2}(?:"([^"]+)"|([a-z][a-z0-9]*)):/gm)) {
    tabled.add(m[1] ?? m[2]);
  }
  for (const m of cli.matchAll(/["']?([a-z][a-z0-9-]*)["']?\s*:\s*\{\s*handler\s*:/g)) {
    (tabled.has(m[1]) ? validating : missing).push(m[1]);
  }
  return { validating: validating.sort(), missing: missing.sort() };
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

interface ContractFlagCommand {
  "x-kit-args-modeled"?: unknown;
  "x-kit-accepted-flags"?: unknown;
}

/**
 * Read per-command accepted flag names from the committed OpenCLI contract.
 * Returns null when no command has modeled flag names — the caller must report
 * "could not verify", never quietly fall back to a repo-global grep.
 */
export function loadContractFlagSurface(repoRoot: string): Map<string, Set<string>> | null {
  try {
    const raw = readFileSync(join(repoRoot, CONTRACT_PATH), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    const commands = (parsed as { commands?: unknown })?.commands;
    if (!commands || typeof commands !== "object") return null;

    const out = new Map<string, Set<string>>();
    for (const [verb, value] of Object.entries(commands as Record<string, ContractFlagCommand>)) {
      if (value["x-kit-args-modeled"] !== true) continue;
      const flags = value["x-kit-accepted-flags"];
      if (!Array.isArray(flags) || !flags.every((f) => typeof f === "string")) continue;
      out.set(verb, new Set(flags));
    }
    return out.size > 0 ? out : null;
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
    name: "documented config sections",
    unit: "`[section]`",
    extract: extractDocTomlSections,
    render: (v) => `[${v}]`,
  },
  {
    name: "documented env vars",
    unit: "`KIT_*`",
    extract: extractDocEnvVars,
    render: (v) => v,
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
/**
 * The complete set of commands kit CLAIMS TO HAVE — the union of two oracles, because
 * each alone has a blind spot that hides a real gap:
 *
 *   - `contracts/kit.opencli.json` lists 71 top-level verbs and NO subcommands, so on its
 *     own it cannot see that `kit hooks uninstall` is undocumented.
 *   - `COMMAND_HELP` in cli.ts lists subcommands but omits some top-level verbs, so on its
 *     own it cannot see that `kit insight` is undocumented.
 *
 * Measured: the contract-only view reported 1 gap, the help-only view reported 9, and
 * neither was a superset of the other. A union is the only honest oracle here.
 *
 * `x-kit-audience: "harness"` verbs are EXCLUDED, and that exclusion is read from the
 * contract rather than hardcoded: `gate-bash`, `gate-env`, `gate-fs` and `gate-egress` are
 * invoked by hook wiring, never typed by a human, so requiring them in human documentation
 * would manufacture busywork rather than catch anything.
 */
export function loadCommandSurface(repoRoot: string): { verb: string; harness: boolean }[] {
  const out = new Map<string, boolean>();
  let contract: Record<string, { "x-kit-audience"?: string }> = {};
  try {
    const raw = readFileSync(join(repoRoot, CONTRACT_PATH), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    const commands = (parsed as { commands?: unknown })?.commands;
    if (commands && typeof commands === "object") {
      contract = commands as Record<string, { "x-kit-audience"?: string }>;
    }
  } catch {
    contract = {};
  }
  const isHarness = (verb: string): boolean =>
    contract[verb.split(" ")[0]]?.["x-kit-audience"] === "harness";

  for (const verb of Object.keys(contract)) out.set(verb, isHarness(verb));

  // COMMAND_HELP keys, read as text so this stays a static audit with no import cycle.
  try {
    const cli = readFileSync(join(repoRoot, "src/cli.ts"), "utf-8");
    const block = cli.slice(cli.indexOf("COMMAND_HELP"));
    for (const m of block.matchAll(/^ {2}"([a-z][a-z0-9 :._-]*)":/gm)) {
      out.set(m[1], isHarness(m[1]));
    }
  } catch {
    /* contract alone still yields a usable, smaller surface */
  }

  return [...out].map(([verb, harness]) => ({ verb, harness }));
}

function runDocumentedFlagsAudit(
  repoRoot: string,
  inScope: { file: string; text: string }[],
  exemptFiles: number,
): SecurityCheckResult {
  const surface = loadContractFlagSurface(repoRoot);
  if (!surface) {
    return {
      category: DOCS_CATEGORY,
      name: "documented flags",
      status: "warn",
      severity: "medium",
      detail: `${CONTRACT_PATH} has no modeled accepted flag names — accepted flag names NOT verified`,
      didNotRun: true,
      suggestion: "regenerate the OpenCLI contract after flag-surface is wired into it",
    };
  }

  const unknown: DocFlagRef[] = [];
  const unverified: DocFlagRef[] = [];
  let checked = 0;

  for (const { file, text } of inScope) {
    for (const ref of extractDocFlagRefs(text, file)) {
      checked++;
      const accepted = surface.get(ref.command);
      if (!accepted) {
        unverified.push(ref);
        continue;
      }
      if (!accepted.has(ref.flag)) unknown.push(ref);
    }
  }

  if (unknown.length > 0) {
    return {
      category: DOCS_CATEGORY,
      name: "documented flags",
      status: "fail",
      severity: "medium",
      detail:
        `${unknown.length} of ${checked} \`kit <command> --flag\` ref(s) do not exist: ` +
        unknown
          .slice(0, 6)
          .map((u) => `kit ${u.command} ${u.flag} (${u.file}:${u.line})`)
          .join(", "),
      files: [...new Set(unknown.map((u) => u.file))],
      suggestion:
        "fix the doc, or add the flag to that command's declared flag surface — a real flag on the wrong command still misleads readers",
    };
  }

  if (unverified.length > 0) {
    return {
      category: DOCS_CATEGORY,
      name: "documented flags",
      status: "warn",
      severity: "medium",
      detail:
        `${unverified.length} of ${checked} \`kit <command> --flag\` ref(s) could not be verified ` +
        `because their command has no modeled accepted flag names: ` +
        unverified
          .slice(0, 6)
          .map((u) => `kit ${u.command} ${u.flag} (${u.file}:${u.line})`)
          .join(", "),
      files: [...new Set(unverified.map((u) => u.file))],
      didNotRun: true,
      suggestion: "regenerate the OpenCLI contract so every command has x-kit-accepted-flags",
    };
  }

  return {
    category: DOCS_CATEGORY,
    name: "documented flags",
    status: "pass",
    detail:
      `${checked} \`kit <command> --flag\` ref(s) across ${inScope.length} doc(s) all resolve ` +
      `against ${surface.size} modeled command(s) (${exemptFiles} doc(s) exempt)`,
  };
}

/**
 * Does any doc invoke `verb`? Brace form counts: `kit hooks {install,add,sync}` documents
 * `hooks install`. Without that, the repo's own house style would read as 40+ false gaps.
 */
function docsMentionCommand(corpus: string, verb: string): boolean {
  if (corpus.includes(`kit ${verb}`)) return true;
  const parts = verb.split(" ");
  if (parts.length < 2) return false;
  const sub = parts
    .slice(1)
    .join(" ")
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`kit\\s+${parts[0]}\\s*\\{[^}]*\\b${sub}\\b`).test(corpus);
}

/**
 * THE INVERSE GATE. `documented commands` proves no doc names something kit lacks; this
 * proves kit ships nothing a reader cannot find. Both directions are needed for "kit is
 * what kit says it is" — the existing gate could not have caught an undocumented
 * enforcement off-switch, because nothing in the docs pointed at it to be checked.
 *
 * Requiring the invocable form (`kit profile import`) rather than a prose mention is
 * deliberate and symmetric with the sibling rule, which extracts `kit <command>` refs: a
 * command a reader cannot see how to type is not documented.
 */
export function undocumentedCommands(repoRoot: string): SecurityCheckResult {
  const surface = loadCommandSurface(repoRoot);
  const inScope = surface.filter((c) => !c.harness);
  if (inScope.length === 0) {
    return {
      category: DOCS_CATEGORY,
      name: "undocumented commands",
      status: "warn",
      severity: "medium",
      detail: "could not read the command surface — coverage NOT verified",
      didNotRun: true,
      suggestion: "regenerate the contract (npm run build) so the inverse audit can run",
    };
  }

  const corpus = findMarkdownFiles(repoRoot)
    .filter((f) => !docExemption(f))
    .map((f) => {
      try {
        return readFileSync(join(repoRoot, f), "utf-8");
      } catch {
        return "";
      }
    })
    .join("\n");

  const missing = inScope.filter((c) => !docsMentionCommand(corpus, c.verb)).map((c) => c.verb);
  const harnessCount = surface.length - inScope.length;

  if (missing.length === 0) {
    return {
      category: DOCS_CATEGORY,
      name: "undocumented commands",
      status: "pass",
      detail:
        `all ${inScope.length} human-facing command(s) appear in the docs ` +
        `(${harnessCount} harness-audience excluded)`,
    };
  }

  return {
    category: DOCS_CATEGORY,
    name: "undocumented commands",
    status: "fail",
    severity: "medium",
    detail:
      `${missing.length} of ${inScope.length} command(s) appear in no doc: ` +
      missing
        .slice(0, 10)
        .map((v) => `kit ${v}`)
        .join(", "),
    suggestion:
      "document it, or mark it harness-audience in the contract if no human should type it",
  };
}

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
    "documented config sections": new Set(KNOWN_SECTIONS),
    "documented env vars": loadKnownEnvVars(repoRoot),
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

  // One advisory row per module that validates nothing. Row-per-module rather than
  // one summary row is deliberate: self-audit's advisory renderer reports the row
  // COUNT per category, so the count becomes the metric itself ("43 command modules
  // that accept unknown flags") instead of a useless "1 advisory findings", and each
  // row carries a navigable path.
  //
  // severity `low` = advisory: never gates, and `--fail-on-warning` stays green on
  // kit's own tree, which cli.test.ts pins as an invariant. Inflating this to a real
  // warning would have broken that guarantee to win visibility — the wrong trade.
  const coverage = flagValidationCoverage(repoRoot);
  const total = coverage.validating.length + coverage.missing.length;
  const flagValidation: SecurityCheckResult[] =
    coverage.missing.length === 0
      ? [
          {
            category: FLAG_VALIDATION_CATEGORY,
            name: "flag validation",
            status: "pass",
            detail: `all ${total} command verb(s) reject unknown flags`,
          },
        ]
      : coverage.missing.map((verb) => ({
          category: FLAG_VALIDATION_CATEGORY,
          name: "flag validation",
          status: "warn" as const,
          severity: "low" as const,
          detail:
            `kit ${verb} accepts unknown flags silently — no entry in the declared flag surface ` +
            `(${coverage.validating.length}/${total} command verbs validate)`,
          files: ["src/flag-surface.ts:1"],
          suggestion: `run 'node scripts/derive-command-flags.mjs --emit' — a flag that silently does nothing is how 'kit check --category' stayed broken across six majors`,
        }));

  const claimResults: SecurityCheckResult[] = CLAIM_CLASSES.map((cls): SecurityCheckResult => {
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

  return flagValidation.concat(
    claimResults.slice(0, 1),
    [runDocumentedFlagsAudit(repoRoot, inScope, exemptFiles)],
    claimResults.slice(1),
    // Appended last on purpose: `flagValidation` occupies res[0] and a test pins that
    // position. Prepending this row displaced it and failed a test about node_modules
    // skipping — an unrelated rule broken by an ordering assumption.
    [undocumentedCommands(repoRoot)],
  );
}
