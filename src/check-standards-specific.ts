/**
 * kit standards — P2: the SPECIFIC (per-language) gate.
 *
 * Where the general gate (check-standards.ts) measures every stack the same way,
 * the specific gate delegates to each ecosystem's own canonical linter run in
 * check/report mode. kit already detects the language (stack-detector) and
 * provisions these tools; this maps the detected language → its linters, runs
 * them, and folds their findings into the same StandardsCheckResult verdict.
 *
 * P2 covers the four ecosystems kit provisions best:
 *   typescript (JS folded in) → eslint, tsc --noEmit
 *   python                    → ruff, mypy
 *   go                        → go vet, gofmt -l
 *   rust                      → cargo clippy, cargo fmt --check
 *
 * Same principles as P1: deterministic (a linter's exit + parsed findings, never a
 * model's judgment), baseline-aware (net-new gating on stable file:rule keys), and
 * warn-by-default / `--enforce` fail-closed. A linter that isn't installed is an
 * honest SETUP GAP (didNotRun), never a silent pass.
 *
 * Each linter is a declarative LinterSpec with a PURE parser (parseEslintJson,
 * parseTscOutput, …) unit-tested against fixture output — no tool needed.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveToolBin } from "./utils/resolveTool.js";
import { execFileNoThrow, type ExecResult } from "./utils/execFileNoThrow.js";
import type { StandardsCheckResult } from "./check-standards.js";

/** A normalized finding from any specific linter. `line`/`rule` are best-effort. */
export interface SpecificFinding {
  file: string;
  line?: number;
  rule?: string;
  message?: string;
}

/** Stable baseline key for a specific finding (net-new gating). */
export const specificKey = (lang: string, tool: string, f: SpecificFinding): string =>
  `${lang}/${tool}:${f.file}${f.rule ? `#${f.rule}` : f.line ? `:${f.line}` : ""}`;

interface LinterSpec {
  /** Short id, also the [standards.<lang>] toggle key. */
  id: string;
  /** Human label shown in the gate output. */
  label: string;
  /** The binary name resolved mise-first then PATH. */
  bin: string;
  /** Args to run it in report mode (relative to cwd, passed as an array — no shell). */
  args: string[];
  /** Parse stdout/stderr → findings. Pure. */
  parse: (res: ExecResult) => SpecificFinding[];
  /** ms budget (compiling linters like clippy/vet need longer). */
  timeout: number;
  maxBuffer?: number;
}

// ── Pure parsers (unit-tested against fixture output) ──────────────────────────

/** eslint `--format json`: `[{ filePath, messages: [{ line, ruleId, message, severity }] }]`. */
export function parseEslintJson(res: ExecResult): SpecificFinding[] {
  let data: unknown;
  try {
    data = JSON.parse(res.stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const out: SpecificFinding[] = [];
  for (const file of data) {
    const f = (file ?? {}) as Record<string, unknown>;
    const filePath = typeof f.filePath === "string" ? f.filePath : undefined;
    const messages = Array.isArray(f.messages) ? f.messages : [];
    if (!filePath) continue;
    for (const m of messages) {
      const msg = (m ?? {}) as Record<string, unknown>;
      out.push({
        file: filePath,
        line: typeof msg.line === "number" ? msg.line : undefined,
        rule: typeof msg.ruleId === "string" ? msg.ruleId : undefined,
        message: typeof msg.message === "string" ? msg.message : undefined,
      });
    }
  }
  return out;
}

/** tsc `--noEmit --pretty false`: lines `path(line,col): error TSxxxx: message`. */
export function parseTscOutput(res: ExecResult): SpecificFinding[] {
  const text = `${res.stdout}\n${res.stderr}`;
  const out: SpecificFinding[] = [];
  const re = /^(.+?)\((\d+),\d+\):\s+error\s+(TS\d+):\s*(.*)$/;
  for (const line of text.split("\n")) {
    const m = re.exec(line.trim());
    if (m) out.push({ file: m[1], line: Number(m[2]), rule: m[3], message: m[4] });
  }
  return out;
}

/** ruff `--output-format json`: `[{ filename, location: { row }, code, message }]`. */
export function parseRuffJson(res: ExecResult): SpecificFinding[] {
  let data: unknown;
  try {
    data = JSON.parse(res.stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const out: SpecificFinding[] = [];
  for (const d of data) {
    const item = (d ?? {}) as Record<string, unknown>;
    const filename = typeof item.filename === "string" ? item.filename : undefined;
    if (!filename) continue;
    const loc = (item.location ?? {}) as Record<string, unknown>;
    out.push({
      file: filename,
      line: typeof loc.row === "number" ? loc.row : undefined,
      rule: typeof item.code === "string" ? item.code : undefined,
      message: typeof item.message === "string" ? item.message : undefined,
    });
  }
  return out;
}

/** mypy default output: `path:line: error: message  [code]`. */
export function parseMypyOutput(res: ExecResult): SpecificFinding[] {
  const text = `${res.stdout}\n${res.stderr}`;
  const out: SpecificFinding[] = [];
  const re = /^(.+?):(\d+):\s+error:\s+(.*?)(?:\s+\[([a-z-]+)\])?$/;
  for (const line of text.split("\n")) {
    const m = re.exec(line.trim());
    if (m) out.push({ file: m[1], line: Number(m[2]), rule: m[4], message: m[3] });
  }
  return out;
}

/** `go vet ./...` (writes to stderr): `path:line:col: message`. */
export function parseGoVet(res: ExecResult): SpecificFinding[] {
  const text = `${res.stdout}\n${res.stderr}`;
  const out: SpecificFinding[] = [];
  const re = /^(.+?\.go):(\d+):\d+:\s+(.*)$/;
  for (const line of text.split("\n")) {
    const m = re.exec(line.trim());
    if (m) out.push({ file: m[1], line: Number(m[2]), message: m[3] });
  }
  return out;
}

/** `gofmt -l`: one unformatted file path per line (no line number). */
export function parseGofmtList(res: ExecResult): SpecificFinding[] {
  const out: SpecificFinding[] = [];
  for (const line of res.stdout.split("\n")) {
    const f = line.trim();
    if (f && f.endsWith(".go"))
      out.push({ file: f, rule: "gofmt", message: "not gofmt-formatted" });
  }
  return out;
}

/** `cargo clippy --message-format short`: `path:line:col: warning|error: message`. */
export function parseClippyShort(res: ExecResult): SpecificFinding[] {
  const text = `${res.stdout}\n${res.stderr}`;
  const out: SpecificFinding[] = [];
  const re = /^(.+?\.rs):(\d+):\d+:\s+(?:warning|error):\s+(.*)$/;
  for (const line of text.split("\n")) {
    const m = re.exec(line.trim());
    if (m) out.push({ file: m[1], line: Number(m[2]), message: m[3] });
  }
  return out;
}

/** `cargo fmt --check` (rustfmt): `Diff in <path> at line N:` per needing-format hunk. */
export function parseCargoFmtCheck(res: ExecResult): SpecificFinding[] {
  const text = `${res.stdout}\n${res.stderr}`;
  const out: SpecificFinding[] = [];
  const re = /^Diff in (.+?) at line (\d+):/;
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    const m = re.exec(line.trim());
    if (m && !seen.has(m[1])) {
      seen.add(m[1]);
      out.push({
        file: m[1],
        line: Number(m[2]),
        rule: "rustfmt",
        message: "not rustfmt-formatted",
      });
    }
  }
  return out;
}

/** rubocop `--format json`: `{ files: [{ path, offenses: [{ location: { line }, cop_name, message }] }] }`. */
export function parseRubocopJson(res: ExecResult): SpecificFinding[] {
  let data: unknown;
  try {
    data = JSON.parse(res.stdout);
  } catch {
    return [];
  }
  const root = (data ?? {}) as Record<string, unknown>;
  const files = Array.isArray(root.files) ? root.files : [];
  const out: SpecificFinding[] = [];
  for (const f of files) {
    const file = (f ?? {}) as Record<string, unknown>;
    const path = typeof file.path === "string" ? file.path : undefined;
    if (!path) continue;
    const offenses = Array.isArray(file.offenses) ? file.offenses : [];
    for (const o of offenses) {
      const off = (o ?? {}) as Record<string, unknown>;
      const loc = (off.location ?? {}) as Record<string, unknown>;
      out.push({
        file: path,
        line: typeof loc.line === "number" ? loc.line : undefined,
        rule: typeof off.cop_name === "string" ? off.cop_name : undefined,
        message: typeof off.message === "string" ? off.message : undefined,
      });
    }
  }
  return out;
}

/** phpstan `analyse --error-format=json`: `{ files: { "<path>": { messages: [{ line, message }] } } }`. */
export function parsePhpstanJson(res: ExecResult): SpecificFinding[] {
  let data: unknown;
  try {
    data = JSON.parse(res.stdout);
  } catch {
    return [];
  }
  const root = (data ?? {}) as Record<string, unknown>;
  const files = (root.files ?? {}) as Record<string, unknown>;
  const out: SpecificFinding[] = [];
  for (const [path, v] of Object.entries(files)) {
    const messages = Array.isArray((v as Record<string, unknown>)?.messages)
      ? ((v as Record<string, unknown>).messages as unknown[])
      : [];
    for (const m of messages) {
      const msg = (m ?? {}) as Record<string, unknown>;
      out.push({
        file: path,
        line: typeof msg.line === "number" ? msg.line : undefined,
        message: typeof msg.message === "string" ? msg.message : undefined,
      });
    }
  }
  return out;
}

/** ktlint `--reporter=json`: `[{ file, errors: [{ line, message, rule }] }]`. */
export function parseKtlintJson(res: ExecResult): SpecificFinding[] {
  let data: unknown;
  try {
    data = JSON.parse(res.stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const out: SpecificFinding[] = [];
  for (const f of data) {
    const file = (f ?? {}) as Record<string, unknown>;
    const path = typeof file.file === "string" ? file.file : undefined;
    if (!path) continue;
    const errors = Array.isArray(file.errors) ? file.errors : [];
    for (const e of errors) {
      const err = (e ?? {}) as Record<string, unknown>;
      out.push({
        file: path,
        line: typeof err.line === "number" ? err.line : undefined,
        rule: typeof err.rule === "string" ? err.rule : undefined,
        message: typeof err.message === "string" ? err.message : undefined,
      });
    }
  }
  return out;
}

/** Generic `path:line[:col]: [severity:] message` linter output (cppcheck, clang-tidy).
 *  `extFilter` restricts to files with that extension so unrelated lines are ignored. */
export function makeLineColParser(extFilter: RegExp) {
  return (res: ExecResult): SpecificFinding[] => {
    const text = `${res.stdout}\n${res.stderr}`;
    const out: SpecificFinding[] = [];
    const re = /^(.+?):(\d+):(?:\d+:)?\s+(.*)$/;
    for (const line of text.split("\n")) {
      const m = re.exec(line.trim());
      if (m && extFilter.test(m[1])) out.push({ file: m[1], line: Number(m[2]), message: m[3] });
    }
    return out;
  };
}

/** checkstyle plain output: `[SEVERITY] /path/File.java:line:col: message [Rule]`. */
export function parseCheckstyle(res: ExecResult): SpecificFinding[] {
  const text = `${res.stdout}\n${res.stderr}`;
  const out: SpecificFinding[] = [];
  const re = /^\[\w+\]\s+(.+?):(\d+)(?::\d+)?:\s+(.*?)(?:\s+\[(\w+)\])?$/;
  for (const line of text.split("\n")) {
    const m = re.exec(line.trim());
    if (m) out.push({ file: m[1], line: Number(m[2]), rule: m[4], message: m[3] });
  }
  return out;
}

/** `dotnet format --verify-no-changes`: `  path(line,col): error WHITESPACE: msg [proj]`. */
export function parseDotnetFormat(res: ExecResult): SpecificFinding[] {
  const text = `${res.stdout}\n${res.stderr}`;
  const out: SpecificFinding[] = [];
  const re = /^(.+?)\((\d+),\d+\):\s+(?:error|warning)\s+(\w+):\s+(.*?)(?:\s+\[.*\])?$/;
  for (const line of text.split("\n")) {
    const m = re.exec(line.trim());
    if (m) out.push({ file: m[1], line: Number(m[2]), rule: m[3], message: m[4] });
  }
  return out;
}

// ── The per-language registry ──────────────────────────────────────────────────

const REGISTRY: Record<string, LinterSpec[]> = {
  typescript: [
    {
      id: "eslint",
      label: "eslint",
      bin: "eslint",
      args: [".", "--format", "json"],
      parse: parseEslintJson,
      timeout: 120_000,
      maxBuffer: 64 * 1024 * 1024,
    },
    {
      id: "tsc",
      label: "tsc --noEmit",
      bin: "tsc",
      args: ["--noEmit", "--pretty", "false"],
      parse: parseTscOutput,
      timeout: 120_000,
      maxBuffer: 32 * 1024 * 1024,
    },
  ],
  python: [
    {
      id: "ruff",
      label: "ruff",
      bin: "ruff",
      args: ["check", "--output-format", "json", "."],
      parse: parseRuffJson,
      timeout: 60_000,
      maxBuffer: 64 * 1024 * 1024,
    },
    {
      id: "mypy",
      label: "mypy",
      bin: "mypy",
      args: ["."],
      parse: parseMypyOutput,
      timeout: 120_000,
      maxBuffer: 32 * 1024 * 1024,
    },
  ],
  go: [
    {
      id: "vet",
      label: "go vet",
      bin: "go",
      args: ["vet", "./..."],
      parse: parseGoVet,
      timeout: 120_000,
      maxBuffer: 32 * 1024 * 1024,
    },
    {
      id: "gofmt",
      label: "gofmt -l",
      bin: "gofmt",
      args: ["-l", "."],
      parse: parseGofmtList,
      timeout: 30_000,
    },
  ],
  rust: [
    {
      id: "clippy",
      label: "cargo clippy",
      bin: "cargo",
      args: ["clippy", "--message-format", "short", "--quiet"],
      parse: parseClippyShort,
      timeout: 300_000,
      maxBuffer: 64 * 1024 * 1024,
    },
    {
      id: "fmt",
      label: "cargo fmt --check",
      bin: "cargo",
      args: ["fmt", "--check"],
      parse: parseCargoFmtCheck,
      timeout: 60_000,
      maxBuffer: 32 * 1024 * 1024,
    },
  ],
  // ── P4: remaining ecosystems (now that detection covers them) ──────────────────
  ruby: [
    {
      id: "rubocop",
      label: "rubocop",
      bin: "rubocop",
      args: ["--format", "json"],
      parse: parseRubocopJson,
      timeout: 120_000,
      maxBuffer: 64 * 1024 * 1024,
    },
  ],
  php: [
    {
      id: "phpstan",
      label: "phpstan",
      bin: "phpstan",
      args: ["analyse", "--error-format=json", "--no-progress"],
      parse: parsePhpstanJson,
      timeout: 120_000,
      maxBuffer: 64 * 1024 * 1024,
    },
  ],
  kotlin: [
    {
      id: "ktlint",
      label: "ktlint",
      bin: "ktlint",
      args: ["--reporter=json"],
      parse: parseKtlintJson,
      timeout: 120_000,
      maxBuffer: 64 * 1024 * 1024,
    },
  ],
  java: [
    {
      id: "checkstyle",
      label: "checkstyle",
      bin: "checkstyle",
      // needs a ruleset (-c) to run; absent one it errors → honest setup gap.
      args: ["-c", "/google_checks.xml", "src"],
      parse: parseCheckstyle,
      timeout: 120_000,
      maxBuffer: 64 * 1024 * 1024,
    },
  ],
  csharp: [
    {
      id: "dotnet-format",
      label: "dotnet format --verify-no-changes",
      bin: "dotnet",
      args: ["format", "--verify-no-changes", "--verbosity", "quiet"],
      parse: parseDotnetFormat,
      timeout: 300_000,
      maxBuffer: 64 * 1024 * 1024,
    },
  ],
  cpp: [
    {
      id: "cppcheck",
      label: "cppcheck",
      bin: "cppcheck",
      args: ["--enable=warning,style", "--quiet", "--template={file}:{line}: {message}", "."],
      parse: makeLineColParser(/\.(c|cc|cpp|cxx|h|hh|hpp)$/),
      timeout: 180_000,
      maxBuffer: 64 * 1024 * 1024,
    },
  ],
  c: [
    {
      id: "cppcheck",
      label: "cppcheck",
      bin: "cppcheck",
      args: ["--enable=warning,style", "--quiet", "--template={file}:{line}: {message}", "."],
      parse: makeLineColParser(/\.(c|h)$/),
      timeout: 180_000,
      maxBuffer: 64 * 1024 * 1024,
    },
  ],
};

/** The languages the specific gate has linters for (P2 core + P4 breadth). */
export const SPECIFIC_LANGUAGES = Object.keys(REGISTRY);

// ── Runner + result assembly ────────────────────────────────────────────────────

/** Raw run of one linter: its findings, or didNotRun when the binary is absent/errored blind. */
export interface LinterRun {
  spec: { id: string; label: string };
  findings: SpecificFinding[];
  didNotRun: boolean;
}

/**
 * Resolve a linter's binary for THIS project. A node-ecosystem tool (eslint, tsc)
 * MUST come from the project's own `node_modules/.bin` — a global/mise copy resolves
 * types and plugins against the wrong tree and floods false positives (e.g. a global
 * tsc can't see the project's @types, reporting thousands of phantom errors on code
 * that compiles cleanly locally). Project-local first, then mise, then PATH.
 */
async function resolveLinterBin(cwd: string, bin: string): Promise<string | null> {
  const localCandidates = process.platform === "win32" ? [`${bin}.cmd`, `${bin}.exe`, bin] : [bin];
  for (const name of localCandidates) {
    const local = join(cwd, "node_modules", ".bin", name);
    if (existsSync(local)) return local;
  }
  return resolveToolBin(bin);
}

async function runLinter(cwd: string, spec: LinterSpec): Promise<LinterRun> {
  const meta = { id: spec.id, label: spec.label };
  const bin = await resolveLinterBin(cwd, spec.bin);
  if (!bin) return { spec: meta, findings: [], didNotRun: true };
  const res = await execFileNoThrow(bin, spec.args, {
    timeout: spec.timeout,
    maxBuffer: spec.maxBuffer,
  });
  const findings = spec.parse(res);
  // A linter that found issues exits non-zero — that is NOT didNotRun. Only treat a
  // non-zero exit with NO parseable findings AND no stdout as a genuine run failure
  // (e.g. a missing tsconfig / not a cargo project).
  if (!res.ok && findings.length === 0 && !res.stdout.trim()) {
    return { spec: meta, findings: [], didNotRun: true };
  }
  return { spec: meta, findings, didNotRun: false };
}

export interface SpecificScanResult {
  language: string;
  runs: LinterRun[];
}

/**
 * Run every enabled linter for `language`. `enabled` is the per-linter toggle map
 * from `[standards.<lang>]` (absent ⇒ all on). A language with no P2 support returns
 * an empty run set (the specific gate simply contributes nothing).
 */
export async function scanSpecific(
  cwd: string,
  language: string,
  enabled?: Record<string, boolean>,
): Promise<SpecificScanResult> {
  const specs = REGISTRY[language] ?? [];
  const active = specs.filter((s) => enabled?.[s.id] !== false);
  const runs = await Promise.all(active.map((s) => runLinter(cwd, s)));
  return { language, runs };
}

export interface CheckSpecificOptions {
  cwd?: string;
  language: string;
  enforce?: boolean;
  /** Per-linter enable/disable from [standards.<lang>]. */
  enabled?: Record<string, boolean>;
  /** Baseline finding keys (net-new gating). */
  baseline?: string[];
  /** Injected scan (tests / reuse). */
  scan?: SpecificScanResult;
}

/** Build the StandardsCheckResult[] for the specific gate of one language. */
export async function checkStandardsSpecific(
  opts: CheckSpecificOptions,
): Promise<StandardsCheckResult[]> {
  const cwd = opts.cwd ?? process.cwd();
  const enforce = opts.enforce ?? false;
  const scan = opts.scan ?? (await scanSpecific(cwd, opts.language, opts.enabled));
  const seen = new Set(opts.baseline ?? []);
  const results: StandardsCheckResult[] = [];

  for (const run of scan.runs) {
    const name = `${opts.language}: ${run.spec.label}`;
    if (run.didNotRun) {
      results.push({
        category: "standards",
        dimension: "specific",
        name,
        status: enforce ? "fail" : "warn",
        severity: enforce ? "high" : "low",
        didNotRun: true,
        detail: `${run.spec.label} not installed — this specific gate did not run (setup gap); --enforce fails CI on setup gaps`,
      });
      continue;
    }
    const rel = run.findings.map((f) => ({ ...f, file: relPath(cwd, f.file) }));
    const fresh = rel.filter((f) => !seen.has(specificKey(opts.language, run.spec.id, f)));
    if (rel.length === 0) {
      results.push({
        category: "standards",
        dimension: "specific",
        name,
        status: "pass",
        detail: "no findings",
      });
    } else if (fresh.length === 0) {
      results.push({
        category: "standards",
        dimension: "specific",
        name,
        status: "warn",
        severity: "low",
        detail: `${rel.length} pre-existing finding(s) (baseline-frozen)`,
      });
    } else {
      results.push({
        category: "standards",
        dimension: "specific",
        name,
        status: enforce ? "fail" : "warn",
        severity: enforce ? "high" : "medium",
        detail: `${fresh.length} new finding(s) (${rel.length} total)`,
        files: fresh
          .slice(0, 10)
          .map(
            (f) =>
              `${f.file}${f.line ? `:${f.line}` : ""}${f.rule ? ` [${f.rule}]` : ""}${
                f.message ? ` ${f.message}` : ""
              }`,
          ),
      });
    }
  }
  return results;
}

function relPath(cwd: string, p: string): string {
  const norm = p.startsWith(cwd) ? p.slice(cwd.length).replace(/^[/\\]+/, "") : p;
  return norm || p;
}

/** Snapshot current specific findings for `kit baseline freeze` (net-new thereafter). */
export async function collectSpecificKeys(
  cwd: string,
  language: string,
  enabled?: Record<string, boolean>,
): Promise<string[]> {
  const scan = await scanSpecific(cwd, language, enabled);
  const keys: string[] = [];
  for (const run of scan.runs) {
    if (run.didNotRun) continue;
    for (const f of run.findings) {
      keys.push(specificKey(language, run.spec.id, { ...f, file: relPath(cwd, f.file) }));
    }
  }
  return keys;
}
