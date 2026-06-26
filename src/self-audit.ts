/**
 * `kit self-audit` rule registry — the core of kit's dogfooding gate.
 *
 * Zero-LLM, deterministic, local-first. Each rule is a pure analyzer over the
 * repo's TypeScript sources (regex / line-scan; no AST dependency — kit ships no
 * parser). A rule that fires on kit's own *fixed* code is a bug: the keystone
 * integration test asserts kit self-audits with zero `fail` over its current
 * tree, so rules are deliberately tightened to prefer false-negatives over
 * false-positives (especially the error-severity rules that gate CI).
 *
 * Detection classes mirror the 11 supply-chain/self-hardening lessons kit learned
 * from its own incident history (the commit references in each rule's doc point at
 * the pre-fix positive). Class 11 (CI script-path integrity) is delegated to the
 * pure analyzer in self-audit-ci.ts.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import type { SecurityCheckResult } from "./check-security.js";
import { walkSourceFiles } from "./source-walk.js";
import { runCiScriptAudit } from "./self-audit-ci.js";
import { ruleForSelfAudit } from "./rules/catalog.js";

export type SelfAuditSeverity = "error" | "warn" | "info";

export interface SourceFile {
  /** Path relative to repoRoot, posix-style, for stable display/annotation. */
  path: string;
  text: string;
  lines: string[];
}

export interface SelfAuditCtx {
  repoRoot: string;
  sources: SourceFile[];
  pkgJson: Record<string, unknown>;
}

export interface SelfAuditRule {
  id: string;
  name: string;
  detectionClass: string;
  severity: SelfAuditSeverity;
  enabled: boolean;
  run(ctx: SelfAuditCtx): SecurityCheckResult[];
}

/** A single finding inside one source file (1-based line). */
interface Finding {
  file: SourceFile;
  line: number;
  detail: string;
  /** Per-finding status override (R1 emits mixed error/warn from one rule). */
  status?: SecurityCheckResult["status"];
  severity?: SecurityCheckResult["severity"];
}

// ---------------------------------------------------------------------------
// Function-window helper
// ---------------------------------------------------------------------------

interface FnWindow {
  /** 0-based index of first line of the window (inclusive). */
  start: number;
  /** 0-based index of last line of the window (inclusive). */
  end: number;
}

// A "function start" heuristic that covers kit's style: top-level `function`,
// `export function`, `async function`, arrow consts assigned a function, and
// `server.tool(` handler arrows. We don't need exact scoping — we need a bounded
// window per logical function so "validator BEFORE sink" / "guard NEAR handler"
// checks compare lines that actually belong together. Brace-depth tracking from a
// function-start line until depth returns to its starting level closes the window.
const FN_START_RE =
  /(?:^|\s)(?:export\s+)?(?:async\s+)?function\s+[\w$]+\s*\(|=\s*(?:async\s*)?\([^)]*\)\s*(?::[^=]*)?=>|=\s*(?:async\s+)?function\b/;

/**
 * Partition a file into per-function line windows. Lines outside any function
 * (imports, top-level consts) are not returned as windows — the rules only care
 * about logic inside functions. Best-effort brace matching; a window that never
 * closes runs to EOF (acceptable: still a bounded same-fn scope).
 */
function functionWindows(lines: string[]): FnWindow[] {
  const windows: FnWindow[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!FN_START_RE.test(lines[i])) {
      i++;
      continue;
    }
    const start = i;
    // Find the first '{' from the start line onward (the body open).
    let depth = 0;
    let opened = false;
    let j = start;
    for (; j < lines.length; j++) {
      const line = stripStringsAndComments(lines[j]);
      for (const ch of line) {
        if (ch === "{") {
          depth++;
          opened = true;
        } else if (ch === "}") {
          depth--;
        }
      }
      if (opened && depth <= 0) break;
    }
    const end = Math.min(j, lines.length - 1);
    windows.push({ start, end });
    i = end + 1;
  }
  return windows;
}

// Remove string/template/comment content so braces inside them don't skew the
// depth counter. Coarse but sufficient for window detection.
function stripStringsAndComments(line: string): string {
  let out = line.replace(/\/\/.*$/, "");
  out = out.replace(/'(?:\\.|[^'\\])*'/g, "''");
  out = out.replace(/"(?:\\.|[^"\\])*"/g, '""');
  out = out.replace(/`(?:\\.|[^`\\])*`/g, "``");
  return out;
}

/** Text of a window joined back together (whitespace-collapsed for order-free scans). */
function windowText(file: SourceFile, w: FnWindow): string {
  return file.lines.slice(w.start, w.end + 1).join("\n");
}

// ---------------------------------------------------------------------------
// Result shaping
// ---------------------------------------------------------------------------

function statusForSeverity(sev: SelfAuditSeverity): SecurityCheckResult["status"] {
  // error -> fail (gates); warn/info -> warn (info additionally downgraded to low).
  return sev === "error" ? "fail" : "warn";
}

function resultSeverity(sev: SelfAuditSeverity): SecurityCheckResult["severity"] {
  switch (sev) {
    case "error":
      return "high";
    case "warn":
      return "medium";
    case "info":
      return "low";
  }
}

const CATEGORY_PREFIX = "self-audit/";

/** Short class slug used in the result category, e.g. 'fail-open-ci'. */
function classSlug(detectionClass: string): string {
  return detectionClass;
}

function category(detectionClass: string): SecurityCheckResult["category"] {
  return `${CATEGORY_PREFIX}${classSlug(detectionClass)}`;
}

/** Build the standard pass/findings result set for a rule. */
function shape(rule: SelfAuditRule, findings: Finding[]): SecurityCheckResult[] {
  if (findings.length === 0) {
    return [
      {
        category: category(rule.detectionClass),
        name: rule.name,
        status: "pass",
        detail: "no findings",
      },
    ];
  }
  // Cite the catalog rule (CWE/OWASP/kit) for this self-audit rule id, if mapped —
  // surfaces the same citation map `kit check` uses, instead of leaving it dead.
  const ruleRef = ruleForSelfAudit(rule.id);
  return findings.map((f) => ({
    category: category(rule.detectionClass),
    name: rule.name,
    status: f.status ?? statusForSeverity(rule.severity),
    severity: f.severity ?? resultSeverity(rule.severity),
    detail: f.detail,
    files: [`${f.file.path}:${f.line}`],
    ...(ruleRef ? { rule: ruleRef } : {}),
  }));
}

// ---------------------------------------------------------------------------
// Rule predicates (shared)
// ---------------------------------------------------------------------------

const EXEC_CALL_RE = /\b(?:execFileSync|execFile|execSync|spawnSync|spawn|exec)\s*\(/;

/**
 * True when an octal file-mode literal grants NO group/other permission bits
 * (owner-only): `(mode & 0o077) === 0`. Accepts 0o600/0o0600/0o400/0o700; rejects
 * 0o644/0o777. Input is the captured 3-4 octal digits (leading zeros already
 * stripped by the caller's regex group).
 */
function octalIsOwnerOnly(octalDigits: string): boolean {
  const mode = parseInt(octalDigits, 8);
  return (mode & 0o077) === 0;
}

// ---------------------------------------------------------------------------
// R1 — fail-open in CI (workflow run: bodies)
// ---------------------------------------------------------------------------

// R1 is the only source-rule that scans workflow YAML rather than src/*.ts. The
// ctx.sources are TS files, so R1 reads .github/workflows directly from repoRoot.

function listWorkflowFiles(repoRoot: string): string[] {
  const dir = join(repoRoot, ".github", "workflows");
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && (e.name.endsWith(".yml") || e.name.endsWith(".yaml")))
      .map((e) => join(dir, e.name));
  } catch {
    return [];
  }
}

const R1: SelfAuditRule = {
  id: "R1-fail-open-ci",
  name: "fail-open in CI workflows",
  detectionClass: "fail-open-ci",
  severity: "error",
  enabled: true,
  run(ctx) {
    const findings: Finding[] = [];
    const files = listWorkflowFiles(ctx.repoRoot);
    for (const file of files) {
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const lines = text.split("\n");
      const rel = relative(ctx.repoRoot, file).split("\\").join("/");
      const sf: SourceFile = { path: rel, text, lines };
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        // Skip comment-only lines: a `# ... || true ...` doc note is not a step.
        const isComment = trimmed.startsWith("#");
        if (isComment) continue;
        const annotated = /#\s*kit-self-audit:\s*allow-continue-on-error/.test(line);

        // `|| true` swallows the exit code of a CI step — the exact triage-deps
        // fail-open this rule exists to catch. It GATES (fail/high): a reintroduced
        // `|| true` on a security step would silently pass the gate. The documented
        // opt-out is the `# kit-self-audit: allow-continue-on-error` annotation for a
        // genuinely best-effort step.
        if (/\|\|\s*true\b/.test(line) && !annotated) {
          findings.push({
            file: sf,
            line: i + 1,
            status: "fail",
            severity: "high",
            detail: `workflow step uses '|| true', swallowing failures (fail-open): ${trimmed}`,
          });
        }
        // `continue-on-error: true` is fail-open (WARN) unless explicitly opted-out.
        if (/continue-on-error:\s*true/.test(line) && !annotated) {
          findings.push({
            file: sf,
            line: i + 1,
            status: "warn",
            severity: "medium",
            detail: `workflow uses 'continue-on-error: true' (fail-open): ${trimmed}`,
          });
        }
      }
    }
    return shape(R1, findings);
  },
};

// ---------------------------------------------------------------------------
// R1b — NaN-fresh: parsed timestamp compared to a cutoff without a finite guard
// ---------------------------------------------------------------------------

const R1b: SelfAuditRule = {
  id: "R1b-nan-fresh",
  name: "NaN-fresh timestamp comparison",
  detectionClass: "nan-fresh",
  severity: "warn",
  enabled: true,
  run(ctx) {
    const findings: Finding[] = [];
    for (const file of ctx.sources) {
      for (const w of functionWindows(file.lines)) {
        // Find a parse of a timestamp into a numeric value within the window.
        let parseLine = -1;
        let parseVar = "";
        for (let i = w.start; i <= w.end; i++) {
          const m =
            /(?:const|let|var)\s+([\w$]+)\s*=\s*(?:[^=]*\?\s*)?(?:Date\.parse|Number)\s*\(/.exec(
              file.lines[i],
            );
          if (m) {
            parseLine = i;
            parseVar = m[1];
            break;
          }
        }
        if (parseLine < 0) continue;

        // Is there a guard (Number.isFinite / !isNaN / isNaN) on that var
        // anywhere in the window? Order doesn't matter — a guard present anywhere
        // in the same fn means the comparison can't be reached with NaN.
        const wtext = windowText(file, w);
        const guarded =
          new RegExp(`Number\\.isFinite\\s*\\(\\s*${escapeRe(parseVar)}\\b`).test(wtext) ||
          new RegExp(`!\\s*isNaN\\s*\\(\\s*${escapeRe(parseVar)}\\b`).test(wtext) ||
          new RegExp(`isNaN\\s*\\(\\s*${escapeRe(parseVar)}\\b`).test(wtext);

        // Is the parsed var compared with < or > against something (a cutoff)?
        const compareLineIdx = findLineMatching(
          file.lines,
          w,
          new RegExp(`\\b${escapeRe(parseVar)}\\s*[<>]`),
        );
        if (compareLineIdx >= 0 && !guarded) {
          findings.push({
            file,
            line: compareLineIdx + 1,
            detail: `'${parseVar}' parsed from a timestamp is compared to a cutoff without a Number.isFinite/!isNaN guard — NaN<cutoff is false (fail-open as "fresh")`,
          });
        }
      }
    }
    return shape(R1b, findings);
  },
};

// ---------------------------------------------------------------------------
// R2 — secret leaked through an exec-error surfaced raw
// ---------------------------------------------------------------------------

// A function that (a) builds an exec/execFile/spawn argv carrying a secret-bearing
// token AND (b) surfaces err.message/String(err) into failed.push(...)/throw in the
// same fn, WITHOUT routing through safeErrorMessage(/redactSecrets(. The
// secret-token requirement keeps this from firing on the many benign execs that
// surface errors (e.g. `git status` failures).
const SECRET_ARGV_RE = /\b(?:secret|--body|--token|password|api[-_]?key|--password)\b/i;
const RAW_ERR_SURFACE_RE =
  /(?:failed\.push\s*\(|throw\b)[^\n]*(?:err(?:or)?\.message|String\s*\(\s*err)/;

const R2: SelfAuditRule = {
  id: "R2-secret-argv",
  name: "secret leaked via exec error",
  detectionClass: "secret-argv",
  severity: "warn",
  enabled: true,
  run(ctx) {
    const findings: Finding[] = [];
    for (const file of ctx.sources) {
      for (const w of functionWindows(file.lines)) {
        const wtext = windowText(file, w);
        const buildsExec = EXEC_CALL_RE.test(wtext);
        const secretArgv = SECRET_ARGV_RE.test(wtext);
        if (!buildsExec || !secretArgv) continue;

        const surfaceIdx = findLineMatching(file.lines, w, RAW_ERR_SURFACE_RE);
        if (surfaceIdx < 0) continue;

        const guarded = /safeErrorMessage\s*\(|redactSecrets\s*\(/.test(wtext);
        if (!guarded) {
          findings.push({
            file,
            line: surfaceIdx + 1,
            detail:
              "function builds an exec argv carrying a secret and surfaces the raw exec error (which embeds argv) without safeErrorMessage()/redactSecrets()",
          });
        }
      }
    }
    return shape(R2, findings);
  },
};

// ---------------------------------------------------------------------------
// R3 — sensitive file written without owner-only perms
// ---------------------------------------------------------------------------

// Sensitive path tokens, matched on the write's target argument. `process.env`
// is explicitly excluded (it contains a literal ".env" substring but is not a
// file path). Tokens must look like a filename component, not part of a longer
// identifier like GITHUB_STEP_SUMMARY.
const SENSITIVE_PATH_RE = /\.env(?:\.|["'`\s)]|$)|\.db\b|-wal\b|-shm\b|\btoken\b|\bsecret\b/i;
const WRITE_SINK_RE = /\b(?:writeFile|writeFileSync|appendFile|appendFileSync)\s*\(/;
const MKDIR_RE = /\b(?:mkdir|mkdirSync)\s*\(/;
// A write whose content arg is an empty/placeholder literal ("{}", "", "[]") can
// carry no secret — exclude it (e.g. a test-only token-store reset).
const EMPTY_CONTENT_WRITE_RE = /,\s*(?:""|''|"\{\}\\?n?"|'\{\}'|"\[\]"|"\{\}"|`\{\}`)/;

const R3: SelfAuditRule = {
  id: "R3-state-perms",
  name: "sensitive file written world-readable",
  detectionClass: "state-perms",
  severity: "error",
  enabled: true,
  run(ctx) {
    const findings: Finding[] = [];
    for (const file of ctx.sources) {
      for (const w of functionWindows(file.lines)) {
        const wtext = windowText(file, w);
        const hasSecure = /secureFile\s*\(|secureDir\s*\(/.test(wtext);

        for (let i = w.start; i <= w.end; i++) {
          const line = file.lines[i];

          // A write/append to a sensitive-looking path. `process.env` substrings
          // and empty-content writes are not secret-bearing.
          const target = line.replace(/process\.env\b/g, "process_env");
          if (
            WRITE_SINK_RE.test(line) &&
            SENSITIVE_PATH_RE.test(target) &&
            !EMPTY_CONTENT_WRITE_RE.test(line)
          ) {
            // Presence of a `mode:` octal is not enough — a world-readable mode
            // (0o644/0o777) is the exact bug. hasMode is true ONLY for an
            // owner-only literal; a non-literal/identifier mode (e.g. `mode: SECURE`)
            // leaves hasMode false so a secureFile()/secureDir() is still required
            // (we don't hard-fail on an unknown mode, but we don't trust it either).
            const modeMatch = /\bmode\s*:\s*0o0*([0-7]{3,4})\b/.exec(line);
            const hasMode = modeMatch ? octalIsOwnerOnly(modeMatch[1]) : false;
            if (!hasMode && !hasSecure) {
              findings.push({
                file,
                line: i + 1,
                detail:
                  "write to a sensitive path (.env/.db/token/secret) without { mode: 0o600 } in-call or a secureFile()/secureDir() in the same function",
              });
            }
          }

          // mkdir of a secret dir must be followed by secureDir() in the same fn
          // (NTFS ignores mkdir mode bits) — OR carry an owner-only inline mode.
          const mkdirModeMatch = /\bmode\s*:\s*0o0*([0-7]{3,4})\b/.exec(line);
          const mkdirOwnerOnly = mkdirModeMatch ? octalIsOwnerOnly(mkdirModeMatch[1]) : false;
          if (
            MKDIR_RE.test(line) &&
            SENSITIVE_PATH_RE.test(target) &&
            !/secureDir\s*\(/.test(wtext) &&
            !mkdirOwnerOnly
          ) {
            findings.push({
              file,
              line: i + 1,
              detail:
                "mkdir of a secret directory without a secureDir() in the same function (NTFS ignores mkdir mode bits)",
            });
          }
        }
      }
    }
    return shape(R3, findings);
  },
};

// ---------------------------------------------------------------------------
// R4 — validate before use (sink reached before validator in same fn)
// ---------------------------------------------------------------------------

// Sinks that consume an externally-influenced argument. Matched on the
// comment-stripped line so doc references ("`npm pack` runs scripts") don't count.
//   - npm pack: an exec/spawn argv containing a literal "pack" element.
//   - dynamic import: import() of a VARIABLE (string-literal module ids like
//     `import("node:fs")` are static and need no validation).
//   - tar extract: a `-x...` flag in a tar invocation.
const SINK_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /["']npm["']\s*,\s*\[\s*["']pack["']|["']pack["']\s*,\s*spec\b/, label: "npm pack" },
  { re: /\bimport\s*\(\s*(?!["'`])[\w$]/, label: "dynamic import" },
  { re: /["']tar["'][^\n]*["']-x/, label: "tar extract" },
];
const VALIDATOR_RE =
  /\bisRegistrySpec\s*\(|\bisValidPluginName\s*\(|\bisUnsafeEntry\s*\(|\blistTarballEntries\s*\(|\bNumber\.isFinite\s*\(/;

const R4: SelfAuditRule = {
  id: "R4-validate-before-use",
  name: "sink reached before validator",
  detectionClass: "validate-before-use",
  severity: "warn",
  enabled: true,
  run(ctx) {
    const findings: Finding[] = [];
    for (const file of ctx.sources) {
      // Comment-stripped view so sink/validator matches reflect real code only.
      const code = file.lines.map((l) => stripStringsAndCommentsKeepStrings(l));
      for (const w of functionWindows(file.lines)) {
        // Earliest validator line index in the window (-1 if none).
        const validatorIdx = findLineMatching(code, w, VALIDATOR_RE);

        for (const sink of SINK_PATTERNS) {
          // The dynamic-import sink is matched over the JOINED window (dot-all) so a
          // Prettier-wrapped `import(\n  spec\n)` is still detected — a per-physical
          // -line scan misses the wrapped form. Other sinks stay line-scoped.
          const sinkIdx =
            sink.label === "dynamic import"
              ? findDynamicImportLine(code, w, R4_DYNAMIC_IMPORT_RE)
              : findLineMatching(code, w, sink.re);
          if (sinkIdx < 0) continue;
          // Finding iff there is NO validator at an EARLIER line than the sink.
          if (validatorIdx < 0 || validatorIdx >= sinkIdx) {
            findings.push({
              file,
              line: sinkIdx + 1,
              detail: `${sink.label} sink invoked without a validator (isRegistrySpec/isValidPluginName/isUnsafeEntry/Number.isFinite) at an earlier line in the same function`,
            });
          }
        }
      }
    }
    return shape(R4, findings);
  },
};

// ---------------------------------------------------------------------------
// R6 — dynamic import of a variable without name-validation AND path-containment
// ---------------------------------------------------------------------------

const NAME_VALIDATION_RE = /\bisValidPluginName\s*\(|_NAME_RE\b|NAME_RE\.test\s*\(/;
const PATH_CONTAINMENT_RE = /\brelative\s*\([^)]*\)[\s\S]{0,40}?\.startsWith\s*\(\s*["']\.\.["']/;

const R6: SelfAuditRule = {
  id: "R6-dynamic-import",
  name: "unvalidated dynamic import",
  detectionClass: "dynamic-import",
  severity: "error",
  enabled: true,
  run(ctx) {
    const findings: Finding[] = [];
    for (const file of ctx.sources) {
      for (const w of functionWindows(file.lines)) {
        const wtext = windowText(file, w);
        // Dynamic import/require whose arg is a variable (not a string literal).
        // Scan the JOINED window text (\s matches newlines) so a Prettier-wrapped
        // `await import(\n  name\n)` is still caught — a per-physical-line scan
        // misses the wrapped form entirely (RCE-class false-negative). The line is
        // anchored to the `import`/`require` keyword for the annotation.
        const dynIdx = findDynamicImportLine(file.lines, w);
        if (dynIdx < 0) continue;

        const hasName = NAME_VALIDATION_RE.test(wtext);
        const hasContainment = PATH_CONTAINMENT_RE.test(wtext);
        if (!hasName || !hasContainment) {
          const missing = [
            hasName ? null : "name-validation (isValidPluginName/_NAME_RE)",
            hasContainment ? null : "path-containment (relative(...).startsWith('..'))",
          ]
            .filter(Boolean)
            .join(" and ");
          findings.push({
            file,
            line: dynIdx + 1,
            detail: `dynamic import of a variable missing ${missing} in the same function`,
          });
        }
      }
    }
    return shape(R6, findings);
  },
};

// ---------------------------------------------------------------------------
// R7 — output escaping: CI/XML/markdown interpolation of a raw variable
// ---------------------------------------------------------------------------

// Recognized output-escaper helpers. CEF/syslog (cefHeader/cefExt) escape into
// their own SIEM formats; mdCell escapes markdown table cells; escapeWorkflowCmd /
// xmlEscape cover GitHub workflow commands and JUnit XML respectively.
const ESCAPER_NAME_RE = /\b(?:escapeWorkflowCmd|xmlEscape|mdCell|cefHeader|cefExt)\s*\(/;

const R7: SelfAuditRule = {
  id: "R7-output-escaping",
  name: "unescaped CI/XML output",
  detectionClass: "output-escaping",
  severity: "error",
  enabled: true,
  run(ctx) {
    const findings: Finding[] = [];
    for (const file of ctx.sources) {
      for (const w of functionWindows(file.lines)) {
        const wtext = windowText(file, w);
        // The pre-fix signature is INCONSISTENT escaping: a function that knows to
        // escape (uses an escaper somewhere) but emits a sink line with a raw,
        // unescaped interpolation. A function that escapes nothing is a coarser gap
        // outside R7's signature (and would false-positive on emitters that pass
        // pre-sanitised, kit-internal enum fields), so we require an escaper present.
        if (!ESCAPER_NAME_RE.test(wtext)) continue;

        // Variables assigned from an escaper earlier in the window are themselves
        // safe to interpolate raw (e.g. `const msg = escapeWorkflowCmd(...)`).
        const escapedVars = new Set<string>();
        for (let i = w.start; i <= w.end; i++) {
          const m =
            /(?:const|let|var)\s+([\w$]+)\s*=\s*(?:escapeWorkflowCmd|xmlEscape|mdCell|cefHeader|cefExt)\s*\(/.exec(
              file.lines[i],
            );
          if (m) escapedVars.add(m[1]);
        }

        for (let i = w.start; i <= w.end; i++) {
          const line = file.lines[i];
          const isCiCmd = /::(?:error|warning|notice)::/.test(line);
          const isXmlFailure = /<failure\s+message=/.test(line);
          const isTestcase = /<testcase\b/.test(line);
          const isSummaryRow = /GITHUB_STEP_SUMMARY/.test(line);
          if (!isCiCmd && !isXmlFailure && !isTestcase && !isSummaryRow) continue;

          const interps = line.match(/\$\{([^}]+)\}/g);
          if (!interps) continue;
          for (const interp of interps) {
            const inner = interp.slice(2, -1).trim();
            // Escaper-wrapped, escaper-derived var, or a non-data literal (emoji
            // ternary, string concat of constants) are all safe.
            if (ESCAPER_NAME_RE.test(inner)) continue;
            if (escapedVars.has(inner)) continue;
            // Bare identifier or member access carrying data -> finding.
            if (/^[\w$.[\]'"]+$/.test(inner)) {
              findings.push({
                file,
                line: i + 1,
                detail: `CI/XML/summary output interpolates '${inner}' without escapeWorkflowCmd()/xmlEscape()/mdCell() (function escapes elsewhere — inconsistent)`,
              });
              break;
            }
          }
        }
      }
    }
    return shape(R7, findings);
  },
};

// ---------------------------------------------------------------------------
// R8 — readonly guard on mutating MCP tools (allowlist scan of mcp-server.ts)
// ---------------------------------------------------------------------------

// Fail-closed: instead of a curated list of MUTATING tools (which silently fails
// open the moment a new mutating tool is added without being listed), we enumerate
// EVERY registered kit_* tool and require a read-only guard unless the tool is on
// the explicit read-only allowlist. To avoid flagging the pure no-op stubs (which
// only assemble a JSON string and have no real sink), a finding fires only when the
// handler body actually performs a side-effect.
//
// READ_ONLY_SAFE: tools whose handlers only inspect/report — no writes, exec, secret
// generation or directory creation. Adding a NEW tool that mutates without a guard
// will be flagged (it is neither allowlisted nor guarded); a new read-only tool must
// be added here deliberately. Keeping this in sync is asserted by the completeness
// test in self-audit.test.ts.
export const READ_ONLY_SAFE = new Set<string>([
  "kit_check",
  "kit_env",
  "kit_ci",
  "kit_context",
  "kit_adapter_check",
  // No-op scaffolding stubs: they assemble a JSON response and perform no real
  // side-effect. If any gains a real sink, drop it here and add the guard.
  "kit_configure",
  "kit_adapter_install",
  "kit_workflow_execute",
  "kit_skill_marketplace",
  "kit_agent_governance",
]);
const GUARD_WINDOW = 12;
// Real side-effects in an MCP handler body: filesystem writes, process exec, secret
// generation, directory creation, service login/provision, tool install. A handler
// with none of these (a JSON-assembling stub) is not a mutation risk.
const MCP_SIDE_EFFECT_RE =
  /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|mkdir|mkdirSync|generateSecrets|loginServices|provisionService|installTools|executeCommand|execFileSync|execFile|execSync|spawnSync|spawn|exec)\s*\(/;
// Registration of a kit_* MCP tool: `server.tool("kit_...",` (name on the next line).
const KIT_TOOL_REG_RE = /["'](kit_[a-z_]+)["']/;

/** Every kit_* tool registered in mcp-server.ts, with the line of its registration. */
export function extractKitTools(file: SourceFile): { name: string; regIdx: number }[] {
  const tools: { name: string; regIdx: number }[] = [];
  for (let i = 0; i < file.lines.length; i++) {
    // Anchor on the `server.tool(` call, then read the tool name from the next
    // non-empty line (kit's style puts the name on its own line).
    if (!/server\.tool\s*\(/.test(file.lines[i])) continue;
    for (let j = i; j < Math.min(file.lines.length, i + 3); j++) {
      const m = KIT_TOOL_REG_RE.exec(file.lines[j]);
      if (m) {
        tools.push({ name: m[1], regIdx: j });
        break;
      }
    }
  }
  return tools;
}

const R8: SelfAuditRule = {
  id: "R8-readonly-guard",
  name: "unguarded mutating MCP tool",
  detectionClass: "readonly-guard",
  severity: "warn",
  enabled: true,
  run(ctx) {
    const findings: Finding[] = [];
    const file = ctx.sources.find((s) => s.path.endsWith("mcp-server.ts"));
    if (!file) return shape(R8, findings);

    for (const tool of extractKitTools(file)) {
      if (READ_ONLY_SAFE.has(tool.name)) continue;

      // The handler entry is the first `async ({...}) =>` after the registration.
      let handlerIdx = -1;
      for (let i = tool.regIdx; i < Math.min(file.lines.length, tool.regIdx + 30); i++) {
        if (/async\s*\([^)]*\)\s*=>/.test(file.lines[i])) {
          handlerIdx = i;
          break;
        }
      }
      if (handlerIdx < 0) continue;

      // Guard must appear near the handler entry (the first lines, before any sink).
      const guardWindow = file.lines
        .slice(handlerIdx, Math.min(file.lines.length, handlerIdx + GUARD_WINDOW))
        .join("\n");
      const guarded = /isReadOnlyMode\s*\(|readOnlyRefusal\s*\(/.test(guardWindow);
      if (guarded) continue;

      // Only fire when the handler body actually mutates — a JSON-assembling stub is
      // not a risk even though it is not allowlisted (defends against false positives
      // on new read-only-ish tools the author forgot to allowlist).
      const handlerBody = bodyTextFrom(file.lines, handlerIdx);
      if (!MCP_SIDE_EFFECT_RE.test(handlerBody)) continue;

      findings.push({
        file,
        line: handlerIdx + 1,
        detail: `mutating MCP tool '${tool.name}' handler performs a side-effect but lacks an isReadOnlyMode()/readOnlyRefusal() guard within ${GUARD_WINDOW} lines of entry`,
      });
    }
    return shape(R8, findings);
  },
};

/** Brace-matched body text starting at the handler-entry line (best-effort, EOF-safe). */
function bodyTextFrom(lines: string[], startIdx: number): string {
  let depth = 0;
  let opened = false;
  let end = startIdx;
  for (let i = startIdx; i < lines.length; i++) {
    const code = stripStringsAndComments(lines[i]);
    for (const ch of code) {
      if (ch === "{") {
        depth++;
        opened = true;
      } else if (ch === "}") {
        depth--;
      }
    }
    end = i;
    if (opened && depth <= 0) break;
  }
  return lines.slice(startIdx, end + 1).join("\n");
}

// ---------------------------------------------------------------------------
// R9 — unkeyed anchor: findings written to the chained audit log raw
// ---------------------------------------------------------------------------

const R9: SelfAuditRule = {
  id: "R9-unkeyed-anchor",
  name: "raw write to chained audit log",
  detectionClass: "unkeyed-anchor",
  severity: "error",
  enabled: true,
  run(ctx) {
    const findings: Finding[] = [];
    for (const file of ctx.sources) {
      for (const w of functionWindows(file.lines)) {
        const usesAppendChained = /appendChained\s*\(/.test(windowText(file, w));
        for (let i = w.start; i <= w.end; i++) {
          const line = file.lines[i];
          if (
            (WRITE_SINK_RE.test(line) || /\bappendFileSync\s*\(/.test(line)) &&
            /\.kit-audit\.jsonl/.test(line) &&
            !usesAppendChained
          ) {
            findings.push({
              file,
              line: i + 1,
              detail:
                "writes to '.kit-audit.jsonl' directly (not via appendChained) — breaks the hash chain; raw findings must target SUPPLY_CHAIN_FINDINGS_FILE/.kit-findings.jsonl",
            });
          }
        }
      }
    }
    return shape(R9, findings);
  },
};

// ---------------------------------------------------------------------------
// R10 — toolchain pin: bare command literal not in the trusted-builtin allowlist
// ---------------------------------------------------------------------------

const TRUSTED_BUILTINS = new Set(["git", "node", "npm", "pnpm", "npx"]);
const BARE_CMD_RE =
  /\b(?:execFileSync|execFile|execSync|spawnSync|spawn|exec)\s*\(\s*["']([\w.-]+)["']/;

const R10: SelfAuditRule = {
  id: "R10-toolchain-pin",
  name: "untrusted bare command",
  detectionClass: "toolchain-pin",
  severity: "info",
  enabled: true,
  run(ctx) {
    const findings: Finding[] = [];
    for (const file of ctx.sources) {
      for (let i = 0; i < file.lines.length; i++) {
        const m = BARE_CMD_RE.exec(file.lines[i]);
        if (!m) continue;
        const cmd = m[1];
        if (TRUSTED_BUILTINS.has(cmd)) continue;
        findings.push({
          file,
          line: i + 1,
          detail: `exec of bare command '${cmd}' not in trusted-builtin allowlist {git,node,npm,pnpm,npx} (informational; relies on PATH resolution)`,
        });
      }
    }
    return shape(R10, findings);
  },
};

// ---------------------------------------------------------------------------
// R5 — env-trust: KIT_* env feeding a relaxation (status -> 'skip')
// ---------------------------------------------------------------------------

const R5: SelfAuditRule = {
  id: "R5-env-trust",
  name: "env-gated check relaxation",
  detectionClass: "env-trust",
  severity: "info",
  enabled: true,
  run(ctx) {
    const findings: Finding[] = [];
    for (const file of ctx.sources) {
      for (const w of functionWindows(file.lines)) {
        for (let i = w.start; i <= w.end; i++) {
          const line = file.lines[i];
          // A conditional that reads a KIT_* env var.
          if (!/process\.env\.KIT_[A-Z0-9_]+/.test(line)) continue;
          if (!/\bif\s*\(|envFlagDisabled\s*\(|envFlagEnabled\s*\(/.test(line)) continue;

          // Does the body of that conditional set a status to 'skip' (relaxation)?
          // Scan the small window after the conditional line. Tightening
          // (env -> 'fail') is GOOD and must NOT be flagged.
          const lookahead = file.lines.slice(i, Math.min(w.end + 1, i + 6)).join("\n");
          const relaxes = /status\s*:\s*["']skip["']/.test(lookahead);
          if (relaxes) {
            findings.push({
              file,
              line: i + 1,
              detail:
                "KIT_* env var gates a check into status:'skip' (relaxation) — inventory only; verify the relaxation is intended",
            });
          }
        }
      }
    }
    return shape(R5, findings);
  },
};

// ---------------------------------------------------------------------------
// R11 — CI script-path integrity (delegated to self-audit-ci)
// ---------------------------------------------------------------------------

const R11: SelfAuditRule = {
  id: "R11-script-paths",
  name: "CI script paths",
  detectionClass: "ci-script-paths",
  severity: "error",
  enabled: true,
  run(ctx) {
    // runCiScriptAudit already returns fully-shaped SecurityCheckResult[] with the
    // self-audit/ci-script-paths category — pass through untouched.
    return runCiScriptAudit(ctx.repoRoot);
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const SELF_AUDIT_RULES: SelfAuditRule[] = [
  R1,
  R1b,
  R2,
  R3,
  R4,
  R5,
  R6,
  R7,
  R8,
  R9,
  R10,
  R11,
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Strip line comments while preserving string literal *contents* (so token
// matches like "pack"/"tar"/"-x" survive but a `// ... npm pack ...` note does
// not). Naive `//` detection: good enough for kit's code; a `//` inside a string
// is rare in the scanned sinks and erring toward stripping favours false-negatives.
function stripStringsAndCommentsKeepStrings(line: string): string {
  // Remove a trailing line comment that is not inside a URL (`://`).
  return line.replace(/(^|[^:])\/\/.*$/, "$1");
}

/** First 0-based line index within window [w] matching [re], or -1. */
function findLineMatching(lines: string[], w: FnWindow, re: RegExp): number {
  for (let i = w.start; i <= w.end; i++) {
    if (re.test(lines[i])) return i;
  }
  return -1;
}

// Dynamic `import(`/`require(` whose first argument is a variable (not a string
// literal), tolerant of Prettier's wrap where the arg sits on a following line:
//   await import(
//     name
//   )
// `\s` (which matches newlines) spans the wrap; the `(?!["'`])` lookahead keeps
// static string-literal module ids (which need no validation) out. The keyword
// `import`/`require` is the match start so its byte offset anchors the reported
// line. R6 requires `await import`/`require`; R4 also accepts a bare `import(`.
const R6_DYNAMIC_IMPORT_RE = /\b(?:await\s+import|require)\s*\(\s*(?!["'`])[\w$]/;
const R4_DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*(?!["'`])[\w$]/;

/**
 * 0-based line index of a wrapped-or-inline dynamic import of a variable within
 * window [w], anchored to the `import`/`require` keyword line, or -1. Joins the
 * window so a Prettier-wrapped call is detected, then maps the match offset back
 * to a physical line.
 */
function findDynamicImportLine(
  lines: string[],
  w: FnWindow,
  re: RegExp = R6_DYNAMIC_IMPORT_RE,
): number {
  const slice = lines.slice(w.start, w.end + 1);
  const joined = slice.join("\n");
  const m = re.exec(joined);
  if (!m) return -1;
  // Map the match start offset to a physical line index (the keyword line).
  const offset = m.index;
  let consumed = 0;
  for (let i = 0; i < slice.length; i++) {
    const lineLen = slice[i].length + 1; // +1 for the join "\n"
    if (offset < consumed + lineLen) return w.start + i;
    consumed += lineLen;
  }
  return w.start;
}

// ---------------------------------------------------------------------------
// Root resolution + orchestration
// ---------------------------------------------------------------------------

/**
 * Walk up from `startDir` (default: this module's dir) to the nearest package.json
 * whose `name` is `sandstream-kit`. Returns that directory or null.
 */
export function resolveKitRoot(startDir?: string): string | null {
  let dir = startDir ?? dirname(fileURLToPath(import.meta.url));
  // Bound the walk to avoid an infinite loop at the filesystem root.
  for (let depth = 0; depth < 64; depth++) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: unknown };
        if (pkg && pkg.name === "sandstream-kit") return dir;
      } catch {
        // Malformed package.json: keep walking up.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Read repoRoot/package.json as a plain object (empty object on failure). */
function readPkgJson(repoRoot: string): Record<string, unknown> {
  const pkgPath = join(repoRoot, "package.json");
  if (!existsSync(pkgPath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(pkgPath, "utf8")) as unknown;
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
  } catch {
    // ignore — empty pkgJson is a valid (degraded) ctx
  }
  return {};
}

/** Build the audit context: src/*.ts (tests excluded) + package.json. */
function buildCtx(repoRoot: string): SelfAuditCtx {
  const srcDir = join(repoRoot, "src");
  const absFiles = walkSourceFiles(existsSync(srcDir) ? srcDir : repoRoot);
  const sources: SourceFile[] = [];
  for (const abs of absFiles) {
    let text: string;
    try {
      text = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    sources.push({
      path: relative(repoRoot, abs).split("\\").join("/"),
      text,
      lines: text.split("\n"),
    });
  }
  return { repoRoot, sources, pkgJson: readPkgJson(repoRoot) };
}

/**
 * Run the self-audit over `repoRoot`. `opts.only` (rule ids) restricts the run;
 * otherwise every enabled rule runs. Results from all rules are concatenated;
 * each result's category is `self-audit/<detection-class>`.
 */
export function runSelfAudit(repoRoot: string, opts?: { only?: string[] }): SecurityCheckResult[] {
  const ctx = buildCtx(repoRoot);
  const only = opts?.only;
  const rules = SELF_AUDIT_RULES.filter((r) =>
    only && only.length > 0 ? only.includes(r.id) : r.enabled,
  );
  const results: SecurityCheckResult[] = [];
  for (const rule of rules) {
    results.push(...rule.run(ctx));
  }
  return results;
}
