#!/usr/bin/env node
/**
 * Generate command flag lists from explicit contracts and a fallback source scan.
 * Explicit contracts describe individual handlers. Their tests must exercise public CLI behavior.
 * The fallback scan collects module literals, direct imports, documented flags, and compatibility flags.
 * It can include sibling handlers or child program flags. It does not prove command behavior.
 * Both unwanted acceptance and rejection of supported flags are defects.
 *
 * Usage:
 *   node scripts/derive-command-flags.mjs            # all modules, human-readable
 *   node scripts/derive-command-flags.mjs --json     # machine-readable
 *   node scripts/derive-command-flags.mjs secrets    # one module
 */
import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFlagContracts } from "./command-flag-contracts.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");
const COMMANDS_DIR = join(SRC, "commands");

/** Flag literals reaching an argv reader. Each pattern captures ONE flag name. */
const FLAG_READ_PATTERNS = [
  // hasFlag(argv, "--a", "--b") — every literal in the call, not just the first.
  /hasFlag\s*\([^)]*?\)/gs,
  /flagValue\s*\([^)]*?\)/gs,
  /flagInt\s*\([^)]*?\)/gs,
];
const INLINE_PATTERNS = [
  /\.includes\(\s*["'`](--[a-z0-9][a-z0-9-]*)["'`]/g,
  /\.indexOf\(\s*["'`](--[a-z0-9][a-z0-9-]*)["'`]/g,
  /===\s*["'`](--[a-z0-9][a-z0-9-]*)["'`]/g,
  /["'`](--[a-z0-9][a-z0-9-]*)["'`]\s*===/g,
  /\.startsWith\(\s*["'`](--[a-z0-9][a-z0-9-]*)["'`]/g,
];
const LITERAL_IN_CALL = /["'`](--[a-z0-9][a-z0-9-]*)["'`]/g;

function readFile(p) {
  try {
    return readFileSync(p, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Strip comments before scanning. kit's own doc comments quote flag literals — flags.ts's
 * header shows `argv.includes("--x")` — and a scanner that reads prose invents flags.
 */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
}

/** Resolve a relative `./x.js` / `../x.js` import to its .ts source. */
function resolveImport(fromFile, spec) {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), spec.replace(/\.js$/, ""));
  for (const cand of [`${base}.ts`, join(base, "index.ts")]) {
    if (existsSync(cand)) return cand;
  }
  return null;
}

function importsOf(file, text) {
  const specs = new Set();
  for (const m of text.matchAll(/from\s+["'`](\.[^"'`]+)["'`]/g)) specs.add(m[1]);
  for (const m of text.matchAll(/import\s*\(\s*["'`](\.[^"'`]+)["'`]\s*\)/g)) specs.add(m[1]);
  const out = [];
  for (const s of specs) {
    const r = resolveImport(file, s);
    if (r) out.push(r);
  }
  return out;
}

/**
 * Flags read by one file.
 *
 * `ownFile` widens the capture to EVERY `--flag` literal in the module's own source, not
 * only the ones handed straight to an argv reader. Measured need: `commands/security.ts`
 * reads `--only` / `--skip` / `--exclude` through a local `commaList(name)` helper, so a
 * reader-only scan missed three real flags — and a missing flag in an allowlist is an
 * outage, while an extra one merely fails to catch a typo.
 */
function flagsInFile(text, ownFile = false) {
  const flags = new Set();
  if (ownFile) {
    for (const m of text.matchAll(LITERAL_IN_CALL)) flags.add(m[1]);
  }
  for (const re of FLAG_READ_PATTERNS) {
    for (const call of text.matchAll(re)) {
      for (const lit of call[0].matchAll(LITERAL_IN_CALL)) flags.add(lit[1]);
    }
  }
  for (const re of INLINE_PATTERNS) {
    for (const m of text.matchAll(re)) flags.add(m[1]);
  }
  return flags;
}

/** Walk a module's import graph, collecting flags per visited file. */
export function flagsForModule(entry, maxDepth = 1) {
  const seen = new Set();
  const flags = new Map(); // flag -> first file that reads it
  const stack = [[entry, 0]];
  while (stack.length > 0) {
    const [file, depth] = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const raw = readFile(file);
    if (raw === null) continue;
    const text = stripComments(raw);
    for (const f of flagsInFile(text, depth === 0)) {
      if (!flags.has(f)) flags.set(f, file.slice(ROOT.length + 1));
    }
    if (depth < maxDepth) {
      for (const imp of importsOf(file, text)) {
        if (!imp.endsWith(".test.ts")) stack.push([imp, depth + 1]);
      }
    }
  }
  return { flags, files: seen.size };
}

/**
 * verb -> the source file that implements it, parsed from cli.ts's imports + COMMAND_REGISTRY.
 *
 * Any relative import counts, not only `./commands/*`: `fix` and `plugin` live in `src/fix.ts`
 * and `src/plugins-cli.ts`, and a commands-only regex silently dropped both — two verbs that
 * would then have had no allowlist and no report saying so.
 */
export function verbToModule() {
  const cli = readFile(join(SRC, "cli.ts")) ?? "";
  const cliPath = join(SRC, "cli.ts");
  const handlerModule = new Map();
  for (const m of cli.matchAll(/import\s*\{([^}]+)\}\s*from\s*["'`](\.[^"'`]+)["'`]/gs)) {
    const file = resolveImport(cliPath, m[2]);
    if (!file) continue;
    for (const name of m[1].split(",").map((s) =>
      s
        .trim()
        .split(/\s+as\s+/)
        .pop(),
    )) {
      if (name) handlerModule.set(name, file);
    }
  }
  // COMMAND_REGISTRY entries are `verb: { handler: cmdX, ... }`.
  const verbs = new Map();
  for (const m of cli.matchAll(
    /["']?([a-z][a-z0-9-]*)["']?\s*:\s*\{\s*handler\s*:\s*(cmd[A-Za-z0-9]+)/g,
  )) {
    const mod = handlerModule.get(m[2]);
    if (mod) verbs.set(m[1], mod);
  }
  return verbs;
}

/**
 * Flags `docs/COMMANDS.md` documents, per verb.
 *
 * Scoped per INVOCATION, not per line, and cut at a `--` separator. A line-wide scan
 * attributed every flag on the line to every verb on it, so documenting
 * `kit run -- pnpm test --watch` (a pass-through example) invented a `kit run --watch` flag —
 * caught by the drift test the moment the doc row was written. Everything after `--` belongs
 * to the wrapped command, and kit never sees it.
 */
export function docFlagsByVerb() {
  const text = readFile(join(ROOT, "docs", "COMMANDS.md")) ?? "";
  const byVerb = new Map();
  for (const line of text.split("\n")) {
    const hits = [...line.matchAll(/`?kit\s+([a-z][a-z0-9-]*)/g)];
    for (let i = 0; i < hits.length; i++) {
      const verb = hits[i][1];
      const from = hits[i].index + hits[i][0].length;
      const to = i + 1 < hits.length ? hits[i + 1].index : line.length;
      let span = line.slice(from, to);
      const sep = span.search(/(^|\s)--(\s|`|$)/);
      if (sep >= 0) span = span.slice(0, sep);
      for (const m of span.matchAll(/(--[a-z0-9][a-z0-9-]*)/g)) {
        if (!byVerb.has(verb)) byVerb.set(verb, new Set());
        byVerb.get(verb).add(m[1]);
      }
    }
  }
  return byVerb;
}

/**
 * Flags kit accepts ON PURPOSE without reading them — deprecated aliases kept working.
 *
 * `commands/agent.ts` states that `--install-gate` "is still accepted for backward
 * compatibility": the gate is default-ON and `--no-install-gate` opts out, so passing the
 * positive form is a no-op that means what it says. Nothing reads it, which is precisely why a
 * scan cannot find it — and a floor built from the scan alone would start rejecting an
 * invocation kit's own generated files still print (`agent-config.ts`'s banner).
 *
 * These aliases apply to commands without an explicit contract.
 * An explicit contract must list each supported compatibility flag itself.
 */
const COMPAT_FLAGS = {
  "agent-config": ["--install-gate"],
};

/**
 * Use an explicit contract when present, including an empty flag list.
 * Use the source scan only for commands without contracts. The dispatcher adds global flags.
 */
export function deriveFlagSurface(depth = 1) {
  const globalSource = readFileSync(join(SRC, "utils", "flags.ts"), "utf8");
  const globalDeclaration = /export const GLOBAL_FLAGS\s*=\s*\[([\s\S]*?)\]\s*as const/.exec(
    globalSource,
  );
  if (!globalDeclaration) throw new Error("Cannot read the global flag declaration");
  const globalFlags = new Set(
    [...globalDeclaration[1].matchAll(LITERAL_IN_CALL)].map((match) => match[1]),
  );
  if (globalFlags.size === 0) throw new Error("The global flag declaration is empty");
  const verbs = verbToModule();
  const declarations = JSON.parse(
    readFileSync(join(ROOT, "contracts", "command-flags.json"), "utf8"),
  );
  const contracts = parseFlagContracts(declarations, new Set(verbs.keys()), globalFlags);
  for (const [verb, entry] of Object.entries(declarations.commands)) {
    for (const test of entry.tests) {
      if (!existsSync(join(ROOT, test)))
        throw new Error(`Invalid command flag contract: ${verb} test missing: ${test}`);
    }
  }
  const docFlags = docFlagsByVerb();
  const perModule = new Map();
  const surface = {};
  const bareFlags = {};
  for (const [verb, file] of verbs) {
    if (contracts.has(verb)) {
      surface[verb] = contracts.get(verb).flags;
      bareFlags[verb] = contracts.get(verb).bareFlags;
      continue;
    }
    if (!perModule.has(file)) perModule.set(file, flagsForModule(file, depth).flags);
    const flags = new Set(perModule.get(file).keys());
    for (const f of docFlags.get(verb) ?? []) flags.add(f);
    for (const f of COMPAT_FLAGS[verb] ?? []) flags.add(f);
    surface[verb] = [...flags].filter((flag) => !globalFlags.has(flag)).sort();
  }
  return { surface, bareFlags, verbs };
}

const GENERATED_HEADER = `/**
 * This generated table lists the flags accepted by each command.
 * The dispatcher checks the table once for every invocation.
 * Generate it with: node scripts/derive-command-flags.mjs --emit
 * flag-surface.test.ts checks that this file matches the generator.
 *
 * Explicit declarations live in contracts/command-flags.json with behavioral test references.
 * Other commands use a source scan, documented flags, and compatibility flags.
 * The fallback scan can include unrelated flags from sibling handlers or subprocesses.
 * A generated list does not prove that every accepted flag affects behavior.
 *
 * The dispatcher adds global flags to every command.
 * A command absent from the table is unvalidated.
 * The self-audit reports unvalidated commands.
 */

`;

function emitFlagTable(name, surface) {
  const lines = [`export const ${name}: Record<string, readonly string[]> = {`];
  for (const verb of Object.keys(surface).sort()) {
    const flags = surface[verb];
    const key = /^[a-z][a-z0-9]*$/.test(verb) ? verb : JSON.stringify(verb);
    const inline = `  ${key}: [${flags.map((f) => JSON.stringify(f)).join(", ")}],`;
    // Match Prettier's width so regeneration preserves identical bytes.
    if (inline.length <= 100) {
      lines.push(inline);
    } else {
      lines.push(`  ${key}: [`);
      for (const f of flags) lines.push(`    ${JSON.stringify(f)},`);
      lines.push(`  ],`);
    }
  }
  lines.push("};");
  return lines;
}

export function emit(surface, bareFlags) {
  const lines = [
    GENERATED_HEADER.replace(/\n+$/, ""),
    "",
    ...emitFlagTable("COMMAND_FLAGS", surface),
    "",
    "/** Declared flags that accept no value. Missing commands have no value contract. */",
    ...emitFlagTable("COMMAND_BARE_FLAGS", bareFlags),
    "",
  ];
  lines.push(`/**
 * Return accepted flags, or null when the command has no table entry.
 * The dispatcher skips absent entries. The self-audit reports that gap.
 */
export function flagsForCommand(verb: string): readonly string[] | null {
  return Object.hasOwn(COMMAND_FLAGS, verb) ? COMMAND_FLAGS[verb] : null;
}

/** Return known flags without values, or null when this command has no declaration. */
export function flagsWithoutValuesForCommand(verb: string): readonly string[] | null {
  return Object.hasOwn(COMMAND_BARE_FLAGS, verb) ? COMMAND_BARE_FLAGS[verb] : null;
}
`);
  return lines.join("\n");
}

function main() {
  const only = process.argv.slice(2).find((a) => !a.startsWith("--"));
  const jsonMode = process.argv.includes("--json");
  const emitMode = process.argv.includes("--emit");
  const depthArg = process.argv.find((a) => a.startsWith("--depth="));
  const depth = depthArg ? Number.parseInt(depthArg.slice("--depth=".length), 10) : 1;

  if (emitMode) {
    const { surface, bareFlags } = deriveFlagSurface(depth);
    const out = join(SRC, "flag-surface.ts");
    writeFileSync(out, emit(surface, bareFlags), "utf-8");
    console.log(`wrote ${out.slice(ROOT.length + 1)} — ${Object.keys(surface).length} verbs`);
    return;
  }

  const modules = readdirSync(COMMANDS_DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => f.replace(/\.ts$/, ""))
    .filter((m) => !only || m === only)
    .sort();

  const verbs = verbToModule();
  const docFlags = docFlagsByVerb();
  const report = {};

  for (const mod of modules) {
    const { flags, files } = flagsForModule(join(COMMANDS_DIR, `${mod}.ts`), depth);
    const modFile = join(COMMANDS_DIR, `${mod}.ts`);
    const modVerbs = [...verbs.entries()].filter(([, f]) => f === modFile).map(([v]) => v);
    const documented = new Set();
    for (const v of modVerbs) for (const f of docFlags.get(v) ?? []) documented.add(f);
    const codeFlags = [...flags.keys()].sort();
    report[mod] = {
      verbs: modVerbs.sort(),
      filesScanned: files,
      code: codeFlags,
      docsOnly: [...documented].filter((f) => !flags.has(f)).sort(),
      sources: Object.fromEntries(codeFlags.map((f) => [f, flags.get(f)])),
    };
  }

  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    for (const [mod, r] of Object.entries(report)) {
      console.log(`\n${mod}  (verbs: ${r.verbs.join(", ") || "—"}, ${r.filesScanned} files)`);
      console.log(`  code:     ${r.code.join(" ") || "—"}`);
      if (r.docsOnly.length > 0) console.log(`  docs-only: ${r.docsOnly.join(" ")}`);
    }
  }
}

// Only run as a CLI — the test imports deriveFlagSurface() as the drift oracle.
if (process.argv[1] && process.argv[1].endsWith("derive-command-flags.mjs")) main();
