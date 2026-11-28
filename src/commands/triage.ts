// `kit triage` commands — extracted from cli.ts (incremental split).
import { c } from "../utils/colors.js";
import { hasFlag } from "../utils/flags.js";
import { runTriage, listTriageTools, type TriageType } from "../triage.js";
import { recordNpxBins } from "../triage-npm-bins.js";
import { SKIPPED_COMMITS_LOG } from "../hooks.js";
import { cmdTriageMcp } from "./triage-mcp.js";
import { discoverPlugins } from "../agent-sbom.js";
import { scanPluginManifest, manifestHasHighRisk } from "../plugin-triage.js";
import { triageVaultConfig } from "../vault-triage.js";
import { triageModelArtifact } from "../model-artifact-triage.js";
import { existsSync, statSync } from "node:fs";
import { redactSecrets } from "../utils/redactSecrets.js";
import { sanitizeDisplayText } from "../display-text.js";
import {
  appendTriagePass,
  TRIAGE_LOG_FILE,
  TRIAGE_MAX_AGE_DAYS,
  type SkillScanEvidence,
  type TriageLogEntry,
} from "../triage-receipt.js";
import {
  readSkillDir,
  resolveSkillTarget,
  skillDigest,
  withLocalSkillSnapshot,
} from "../skill-triage-binding.js";
import { cmdTriageCheckSkills } from "../skill-triage-gate.js";

/** `kit triage <name> …` subcommands that are not a package type. */
const TRIAGE_SUBCOMMANDS: Record<string, (args: string[]) => Promise<boolean>> = {
  mcp: (args) => cmdTriageMcp(args),
  plugin: (args) => cmdTriagePlugin(args),
  "vault-config": () => cmdTriageVaultConfig(),
  model: (args) => cmdTriageModel(args),
  instructions: async (args) =>
    (await import("./triage-instructions.js")).cmdTriageInstructions(args),
  prompt: async (args) => (await import("../triage-prompt.js")).cmdTriagePrompt(args),
  pkg: async (args) => (await import("./triage-pkg.js")).cmdTriagePkg(args),
  release: async (args) => (await import("./triage-release-asset.js")).cmdTriageRelease(args),
  gem: async (args) => (await import("./triage-gem.js")).cmdTriageGem(args),
  cargo: async (args) => (await import("./triage-release.js")).cmdTriageCargo(args),
  go: async (args) => (await import("./triage-release.js")).cmdTriageGo(args),
};

function triageSubcommand(
  name: string | undefined,
): ((args: string[]) => Promise<boolean>) | undefined {
  return name && Object.hasOwn(TRIAGE_SUBCOMMANDS, name) ? TRIAGE_SUBCOMMANDS[name] : undefined;
}

/** Two help rows as one string, so the help block in `cmdTriage` does not grow. */
const PIP_AND_GEM_HELP = [
  "  kit triage pip <package>             Evaluate PyPI package",
  "  kit triage gem <name>[@version]      Evaluate a RubyGems release (cooling, OSV malicious, history); install-time code not read",
  "  kit triage cargo <crate>[@version]   Evaluate a crates.io release (cooling, yanked, OSV, owners); build-time code not read",
  "  kit triage go <package>[@version]    Evaluate a Go module release on the module proxy (cooling, OSV); module source not read",
].join("\n");

/**
 * Every type `kit triage` accepts, for the unknown-type message (several dispatch before it).
 * src/triage-help-coverage.test.ts fails when one of them has no `kit triage <type> --help` entry.
 */
export const TRIAGE_TYPES = [
  "npm",
  "pip",
  "gem",
  "cargo",
  "go",
  "brew",
  "docker",
  "repo",
  "skill",
  "mcp",
  "model",
  "instructions",
  "prompt",
  "pkg",
  "release",
  "plugin",
  "vault-config",
  "all",
  "tools",
  "check-deps",
  "check-skills",
];

const HELP_ROWS = [
  "  kit triage docker <image>           Evaluate Docker image (CVE + sandbox)",
  "  kit triage npm <package>             Evaluate npm package (registry metadata)",
  "  kit triage npm <package> --sandbox   + offline tarball inspection (install-script + path-traversal scan, no code executed)",
  PIP_AND_GEM_HELP,
  "  kit triage brew <formula>            Evaluate Homebrew formula or cask (resolves upstream repo, then repo-scores)",
  "  kit triage repo <github-url>         Evaluate GitHub repository",
  "  kit triage model <path>              Evaluate an untrusted AI artifact (model weights / dataset) before loading",
  "  kit triage model <path> --scan-bytes + byte-level malware scan via a local ClamAV delegate (clean/malicious/gap; never a silent pass)",
  "  kit triage skill <path|name>         Evaluate Claude Code / agent skill",
  "  kit triage skill <path|name> --deep  Require a complete SkillSpector static scan",
  "  kit triage mcp <server> --tools <f>  MCP tool metadata (poisoning) + pin against drift; --init <f> adds the server instructions",
  "  kit triage plugin [name]             Triage kitPlugins (npm supply-chain + manifest-poisoning scan); all declared if no name",
  "  kit triage vault-config              Triage the secret-backend selection (.kit.toml secrets.store + per-key source); never reads secret values",
  "  kit triage all <target>              Auto-detect and run all checks",
  "  kit triage tools                     Show installed security tools",
  "  kit triage check-deps                Pre-commit gate: fail if staged deps lack triage entries",
  "  kit triage check-skills              Pre-commit gate: fail if staged skills lack a --deep triage entry",
  "  kit triage instructions [path]       Read agent instruction files (CLAUDE.md, AGENTS.md, SKILL.md …) for planted attacks",
  '  kit triage prompt "<text>"|-        Read a pasted install prompt (or stdin) for planted attacks, URLs and repos; fetches nothing',
  "  kit triage pkg <file.pkg>            Check a macOS installer: checksum, publisher Team ID, notarization (macOS)",
  "  kit triage release <url|file>        Check a prebuilt release archive or binary: checksum, signature, age, repository, members",
];

function printTriageHelp(): void {
  console.log(`${c.bold}kit triage${c.reset} — Security evaluation before installing packages\n`);
  console.log("Usage:");
  for (const row of HELP_ROWS) console.log(row);
  console.log("");
  console.log("Examples:");
  console.log("  kit triage npm express");
  console.log("  kit triage npm node-ipc --sandbox");
  console.log("  kit triage docker stalwartlabs/stalwart");
  console.log("  kit triage skill searxng");
}

const severityTag = (severity: string): string =>
  severity === "critical"
    ? `${c.red}[CRIT]${c.reset}`
    : severity === "warn"
      ? `${c.yellow}[WARN]${c.reset}`
      : `[info]`;

/** `--sandbox` on npm: offline tarball inspection. Returns false on a critical finding or an error. */
async function npmSandbox(target: string): Promise<boolean> {
  const { triageNpmSandbox } = await import("../triage-sandbox.js");
  console.log(`\n${c.bold}Sandbox inspection (offline):${c.reset}`);
  try {
    const sb = await triageNpmSandbox(target);
    console.log(`  package: ${sb.package}${sb.version ? `@${sb.version}` : ""}`);
    console.log(`  tarball: ${(sb.tarballSize / 1024).toFixed(1)} kB`);
    console.log(`  install scripts: ${sb.hasInstallScripts ? "YES (review below)" : "none"}`);
    if (sb.findings.length === 0) {
      console.log(`  ${c.green}✓ no risk signals${c.reset}`);
      return true;
    }
    for (const f of sb.findings)
      console.log(`  ${severityTag(f.severity)} ${f.signal} — ${f.detail}`);
    return !sb.findings.some((f) => f.severity === "critical");
  } catch (err) {
    console.error(
      `  ${c.red}sandbox failed: ${err instanceof Error ? err.message : String(err)}${c.reset}`,
    );
    return false;
  }
}

/** Run the evaluation of one type and target, the optional sandbox and deep scans, and record a pass. */
async function evaluate(
  type: TriageType,
  target: string,
  sandbox: boolean,
  deep: boolean,
): Promise<boolean> {
  console.log(`${c.bold}Running triage on ${type}: ${redactSecrets(target)}${c.reset}\n`);
  if (deep && type === "skill") return evaluateDeepSkill(target, sandbox);
  const result = await runTriage(type, target);
  console.log(result.output);
  if (!(await recordNpxBins(process.cwd(), result.npxBins)))
    console.error(`${c.dim}(npm-bin record append failed)${c.reset}`);
  if (type === "skill") {
    const { skillInstructionLines } = await import("../triage-skill-instructions.js");
    const lines = skillInstructionLines(target);
    if (lines) console.log(`${lines.join("\n")}\n`);
  }

  const sandboxClean = await requestedSandbox(type, target, sandbox);
  if (deep)
    console.log(
      `\n${c.dim}(--deep currently only applies to skill; ignored for ${type})${c.reset}`,
    );
  if (!result.passed || !sandboxClean) {
    console.log(`\n${c.yellow}⚠️  Review warnings above before proceeding.${c.reset}`);
    return false;
  }
  await recordTriageRun(type, target, sandbox && type === "npm", false, {
    contentDigest: type === "skill" ? localSkillDigest(target) : undefined,
  });
  return true;
}

async function evaluateDeepSkill(target: string, sandbox: boolean): Promise<boolean> {
  try {
    await requestedSandbox("skill", target, sandbox);
    const checked = await withLocalSkillSnapshot(target, async (scanTarget, snapshot) => {
      const base = await runTriage("skill", scanTarget);
      console.log(base.output.replace(/^TRIAGE PASSED\r?$/gm, "Base skill triage passed."));
      const scan = await deepSkillScan(scanTarget, snapshot?.fileCount);
      if (!base.passed || !scan.clean || !scan.evidence) return undefined;
      return { contentDigest: snapshot?.digest, skillScan: scan.evidence };
    });
    if (!checked) return false;
    if (!checked.contentDigest) {
      console.log("Deep scan passed. The commit gate requires a scan of local skill files.");
      return true;
    }
    const recorded = await recordTriageRun("skill", target, false, true, checked);
    if (recorded) console.log("Deep skill triage passed.");
    return recorded;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Deep triage could not finish. ${sanitizeDisplayText(message)}`);
    return false;
  }
}

async function requestedSandbox(
  type: TriageType,
  target: string,
  enabled: boolean,
): Promise<boolean> {
  if (!enabled) return true;
  if (type === "npm") return npmSandbox(target);
  console.log(`\n${c.dim}(--sandbox currently only applies to npm; ignored for ${type})${c.reset}`);
  return true;
}

export async function cmdTriage(): Promise<boolean> {
  const args = process.argv.slice(3);
  const sandbox = hasFlag(args, "--sandbox");
  const deep = hasFlag(args, "--deep");
  const filtered = args.filter((a) => a !== "--sandbox" && a !== "--deep");
  const typeArg = filtered[0];
  // `check-deps` is a pre-commit subcommand handled below before we narrow
  // to TriageType; the rest of this function works against TriageType only.
  if (typeArg === "check-deps") return cmdTriageCheckDeps();
  if (typeArg === "check-skills") return cmdTriageCheckSkills();
  const subcommand = triageSubcommand(typeArg);
  if (subcommand) return subcommand(filtered.slice(1));
  const type = typeArg as TriageType;
  const target = skillTargetFor(type, filtered[1]);

  if (!typeArg || typeArg === "--help" || typeArg === "-h") {
    printTriageHelp();
    return true;
  }

  const validTypes = ["docker", "npm", "pip", "brew", "repo", "skill", "all", "tools"];
  if (!validTypes.includes(type)) {
    console.error(`${c.red}Unknown triage type: ${type}${c.reset}`);
    console.error(`Valid types: ${TRIAGE_TYPES.join(", ")}`);
    return false;
  }
  if (type === "tools") {
    console.log((await listTriageTools()).output);
    return true;
  }
  if (!target) {
    console.error(`${c.red}Target required for triage ${type}${c.reset}`);
    return false;
  }
  return evaluate(type, target, sandbox, deep);
}

/** For `skill`, a bare name means the local `.claude/skills/<name>`; other types are unchanged. */
function skillTargetFor(type: string, target: string | undefined): string | undefined {
  return type === "skill" && target ? resolveSkillTarget(target, process.cwd()) : target;
}

function localSkillDigest(target: string): string | undefined {
  try {
    const files = readSkillDir(target);
    return files ? skillDigest(files) : undefined;
  } catch {
    return undefined;
  }
}

/** Report observed findings and require complete coverage before giving a deep verdict. */
async function deepSkillScan(
  target: string,
  localFileCount = 1,
): Promise<{ clean: boolean; evidence?: SkillScanEvidence }> {
  const { runSkillspectorStage1, SKILLSPECTOR_SOURCE } =
    await import("../skillspector-delegate.js");
  console.log(`\n${c.bold}Deep scan (${SKILLSPECTOR_SOURCE}, static analysis):${c.reset}`);
  const deepRes = await runSkillspectorStage1(target);
  for (const f of deepRes.findings) {
    const sev = f.severity ?? "info";
    const tag =
      sev === "critical" || sev === "high"
        ? `${c.red}[${sev.toUpperCase()}]${c.reset}`
        : `${c.yellow}[${sev}]${c.reset}`;
    console.log(`  ${tag} ${sanitizeDisplayText(f.detail)}`);
  }
  if (deepRes.status !== "ok") {
    console.log(
      `  ${c.red}✗ Deep scan ${deepRes.status}. ${sanitizeDisplayText(deepRes.detail)}${c.reset}`,
    );
    return { clean: false };
  }
  if (deepRes.evidence.runs.some((run) => run.fullyInspectedFiles < localFileCount)) {
    console.log(
      "Deep scan partial. SkillSpector reported fewer inspected files than the local snapshot contains.",
    );
    return { clean: false };
  }
  for (const run of deepRes.evidence.runs) {
    const version = sanitizeDisplayText(run.scannerVersion);
    console.log(
      `  SkillSpector ${version} reports ${run.coveragePercent}% coverage, ${run.fullyInspectedFiles} fully inspected files and ${run.scopeExclusionCount} exclusions.`,
    );
  }
  if (deepRes.findings.length === 0) {
    console.log(`  ${c.green}✓ No findings within the declared coverage.${c.reset}`);
  }
  return {
    clean: !(deepRes.worst === "critical" || deepRes.worst === "high"),
    evidence: deepRes.evidence,
  };
}

/**
 * `kit triage vault-config` — triage the project's secret-backend SELECTION (`.kit.toml`
 * `secrets.store` + per-key `source`): flag an unknown/typo'd backend (silently no vault) and
 * surface local/plaintext sources. Never reads a secret value. Deterministic, zero-LLM.
 */
async function cmdTriageVaultConfig(): Promise<boolean> {
  const { loadConfig } = await import("../config.js");
  const { resolve } = await import("node:path");
  let secrets;
  try {
    const cfg = await loadConfig(resolve(process.cwd(), ".kit.toml"));
    secrets = cfg.secrets;
  } catch {
    console.log(`${c.dim}no readable .kit.toml — nothing to triage.${c.reset}`);
    return true;
  }
  const { findings, passed } = triageVaultConfig(secrets);
  if (findings.length === 0) {
    console.log(
      `${c.dim}no secret-backend selection configured (.kit.toml [secrets]) — nothing to triage.${c.reset}`,
    );
    return true;
  }
  console.log(
    `${c.bold}kit triage vault-config${c.reset} ${c.dim}(backend selection only — no secret values read)${c.reset}`,
  );
  for (const f of findings) {
    const mark =
      f.assurance === "vault-backed"
        ? `${c.green}✓${c.reset}`
        : f.assurance === "local-plaintext"
          ? `${c.yellow}!${c.reset}`
          : `${c.red}✗${c.reset}`;
    console.log(
      `  ${mark} ${f.scope}  ${c.bold}${f.source}${c.reset}  ${c.dim}${f.note}${c.reset}`,
    );
  }
  if (!passed) {
    console.log(
      `\n${c.red}✗ unknown backend id(s) — a typo or unsupported backend means secrets silently fall through.${c.reset}`,
    );
  }
  return passed;
}

/**
 * `kit triage plugin [name]` — triage the project's kitPlugins (npm packages that
 * `loadPluginAdapters` will import + run). For each: the existing npm registry triage
 * (install-scripts / slopsquat / dep-confusion) plus a static manifest-poisoning scan of the
 * installed package.json (R7 injection detector over description/keywords) — never importing the
 * plugin. With no name, triages every plugin declared in package.json `kitPlugins`. Version
 * drift is intentionally left to `kit profile check`. Exits non-zero if any plugin fails.
 */
async function cmdTriagePlugin(args: string[]): Promise<boolean> {
  const { readFile } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  const cwd = process.cwd();
  const explicit = args.find((a) => !a.startsWith("-"));

  const names = explicit ? [explicit] : discoverPlugins(cwd).map((p) => p.name);
  if (names.length === 0) {
    console.log(`${c.dim}no kitPlugins declared in package.json — nothing to triage.${c.reset}`);
    return true;
  }

  let allPassed = true;
  for (const name of names) {
    console.log(
      `\n${c.bold}Triaging plugin: ${name}${c.reset} ${c.dim}(npm supply-chain + manifest)${c.reset}`,
    );
    const result = await runTriage("npm", name);
    console.log(result.output);

    // Static manifest-poisoning scan of the INSTALLED package.json (no import of plugin code).
    let manifestClean = true;
    try {
      const pkg = JSON.parse(
        await readFile(resolve(cwd, "node_modules", name, "package.json"), "utf-8"),
      );
      const findings = scanPluginManifest(pkg);
      if (findings.length === 0) {
        console.log(
          `  ${c.green}✓ manifest clean${c.reset} ${c.dim}(no injection patterns)${c.reset}`,
        );
      } else {
        for (const f of findings) {
          const tag =
            f.confidence === "high" ? `${c.red}[HIGH]${c.reset}` : `${c.yellow}[heur]${c.reset}`;
          console.log(`  ${tag} manifest ${f.field}: ${f.label}`);
        }
        if (manifestHasHighRisk(findings)) manifestClean = false;
      }
    } catch {
      console.log(`  ${c.dim}(plugin not installed — manifest scan skipped)${c.reset}`);
    }

    const pluginPassed = result.passed && manifestClean;
    if (pluginPassed) await recordTriageRun("npm", name, false);
    else allPassed = false;
  }

  if (!allPassed) {
    console.log(`\n${c.yellow}⚠️  Review warnings above before trusting these plugins.${c.reset}`);
  }
  return allPassed;
}

export { TRIAGE_MAX_AGE_DAYS } from "../triage-receipt.js";

/**
 * Append a PASS entry to the triage log. Exported so the MCP `kit_triage` tool
 * records through the SAME path the CLI uses — the pre-commit `check-deps` gate
 * and the install gate read this log, so an MCP-run triage must satisfy them
 * identically to a CLI-run one. `cwd` defaults to process.cwd(); the MCP server
 * passes its per-call working directory.
 */
export async function recordTriageRun(
  type: string,
  target: string,
  sandbox: boolean,
  deep = false,
  opts: { cwd?: string; contentDigest?: string; skillScan?: SkillScanEvidence } = {},
): Promise<boolean> {
  try {
    await appendTriagePass({ type, target, sandbox, deep, ...opts });
    return true;
  } catch (err) {
    console.error(
      `${c.dim}(triage-log append failed: ${err instanceof Error ? err.message : err})${c.reset}`,
    );
    return false;
  }
}

/**
 * `kit triage check-deps` — pre-commit step. Diffs staged dep manifests
 * (package.json, requirements.txt, pyproject.toml) against the cached
 * versions in HEAD; any newly-added top-level package must have a triage
 * entry within the last `TRIAGE_MAX_AGE_DAYS` days. Exits non-zero on
 * missing entries so the commit fails.
 *
 * Intentionally does NOT walk transitive deps — that's the lockfile's
 * job. The pre-commit gate fires on what the developer is signing off on,
 * which is the manifest entries they wrote.
 */
async function cmdTriageCheckDeps(): Promise<boolean> {
  const { execFileSync } = await import("node:child_process");
  const { readFile } = await import("node:fs/promises");
  const { resolve } = await import("node:path");

  const gitShow = (ref: string): string | null => {
    try {
      return execFileSync("git", ["show", ref], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch {
      return null;
    }
  };

  const newDeps: { ecosystem: "npm" | "pip"; name: string }[] = [];

  // package.json — compare staged vs HEAD top-level dependencies.
  const stagedPkg = gitShow(":package.json");
  if (stagedPkg) {
    try {
      const headPkgRaw = gitShow("HEAD:package.json");
      const staged = JSON.parse(stagedPkg) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const head = headPkgRaw
        ? (JSON.parse(headPkgRaw) as {
            dependencies?: Record<string, string>;
            devDependencies?: Record<string, string>;
          })
        : {};
      const stagedDeps = { ...staged.dependencies, ...staged.devDependencies };
      const headDeps = { ...head.dependencies, ...head.devDependencies };
      for (const name of Object.keys(stagedDeps)) {
        if (!(name in headDeps)) newDeps.push({ ecosystem: "npm", name });
      }
    } catch {
      /* malformed package.json — skip */
    }
  }

  // requirements.txt — line-oriented diff.
  const stagedReq = gitShow(":requirements.txt");
  if (stagedReq) {
    const headReq = gitShow("HEAD:requirements.txt") ?? "";
    const parseLines = (text: string) =>
      new Set(
        text
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith("#"))
          .map((l) => l.split(/[<>=!~]/)[0]!.trim()),
      );
    const stagedSet = parseLines(stagedReq);
    const headSet = parseLines(headReq);
    for (const name of stagedSet) {
      if (!headSet.has(name)) newDeps.push({ ecosystem: "pip", name });
    }
  }

  if (newDeps.length === 0) return true;

  // Build a triage-log index of `<ecosystem>:<name>` → most-recent ISO ts.
  const latest: Record<string, string> = {};
  try {
    const text = await readFile(resolve(process.cwd(), TRIAGE_LOG_FILE), "utf-8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as TriageLogEntry;
        const key = `${entry.type}:${entry.target}`;
        const prev = latest[key];
        if (!prev || entry.timestamp > prev) latest[key] = entry.timestamp;
      } catch {
        /* skip malformed line */
      }
    }
  } catch {
    /* no triage log yet */
  }

  const cutoff = Date.now() - TRIAGE_MAX_AGE_DAYS * 24 * 3600 * 1000;
  const missing: string[] = [];
  for (const dep of newDeps) {
    const key = `${dep.ecosystem}:${dep.name}`;
    const ts = latest[key];
    // Parse first and reject non-finite: an unparseable timestamp yields NaN, and
    // `NaN < cutoff` is false — treating a forged/garbage ts as "fresh triage"
    // (fail-open). A missing or unparseable ts both count as "no valid triage".
    const parsed = ts ? Date.parse(ts) : NaN;
    if (!Number.isFinite(parsed) || parsed < cutoff) {
      missing.push(
        `  - ${dep.ecosystem}:${dep.name}  (run: kit triage ${dep.ecosystem} ${dep.name})`,
      );
    }
  }

  if (missing.length === 0) return true;

  console.error(`${c.red}✗ Triage missing for ${missing.length} newly-added dep(s):${c.reset}`);
  for (const line of missing) console.error(line);
  console.error("");
  console.error(
    `${c.dim}Triage policy lives in CLAUDE.md. Run the suggested triage commands above,`,
  );
  console.error(
    `then re-stage and commit. Bypass with --no-verify is recorded to ${SKIPPED_COMMITS_LOG}.${c.reset}`,
  );
  return false;
}

/**
 * `kit triage model <path>` — deterministic, zero-LLM triage of an untrusted AI
 * artifact (model weights / dataset) BEFORE loading it into an inference runtime.
 * Classifies the format's load-time risk (code-exec pickle family = fail; gguf/onnx
 * loader-hardening + data-only = advisory) and flags unverified provenance. A
 * `<path>.sha256` or `<path>.sig` sidecar counts as verified provenance. Exits
 * non-zero on a high-confidence (code-exec) finding.
 */
async function cmdTriageModel(args: string[]): Promise<boolean> {
  const json = hasFlag(args, "--json");
  const scanBytes = hasFlag(args, "--scan-bytes");
  const path = args.find((a) => !a.startsWith("--"));
  if (!path) {
    console.error("usage: kit triage model <path> [--scan-bytes] [--json]");
    return false;
  }
  let sizeBytes: number | undefined;
  if (existsSync(path)) {
    try {
      sizeBytes = statSync(path).size;
    } catch {
      /* stat is best-effort; classification works from the name alone */
    }
  }
  const provenanceVerified = existsSync(`${path}.sha256`) || existsSync(`${path}.sig`);
  const r = triageModelArtifact(path, { sizeBytes, provenanceVerified });

  // Optional byte-level layer: delegate to a locally-installed ClamAV. kit records the
  // verdict; it never becomes the AV. `malicious` forces an overall fail; a scanerror /
  // missing scanner is a GAP (surfaced, never a silent clean).
  let scan: import("../malware-scan.js").MalwareScanResult | undefined;
  if (scanBytes) {
    if (!existsSync(path)) {
      scan = {
        verdict: "scanerror",
        signatures: [],
        ranScanner: false,
        isGap: true,
        detail: "file does not exist — nothing to scan (gap)",
      };
    } else {
      const { scanFileForMalware } = await import("../malware-scan.js");
      scan = await scanFileForMalware(path);
    }
  }

  const overallPass = r.passed && scan?.verdict !== "malicious";

  if (json) {
    console.log(JSON.stringify({ ...r, malwareScan: scan ?? null, passed: overallPass }, null, 2));
    return overallPass;
  }

  console.log(
    `${c.bold}kit triage model${c.reset} — ${r.artifact} ${c.dim}(${r.formatRisk})${c.reset}`,
  );
  for (const f of r.findings) {
    const tag = f.confidence === "high" ? `${c.red}HIGH${c.reset}` : `${c.dim}advisory${c.reset}`;
    console.log(`  [${tag}] ${f.label}`);
    console.log(`      ${c.dim}${f.rationale}${c.reset}`);
  }
  if (scan) {
    const tag =
      scan.verdict === "malicious"
        ? `${c.red}MALWARE${c.reset}`
        : scan.verdict === "clean"
          ? `${c.green}clean${c.reset}`
          : `${c.yellow}gap${c.reset}`;
    console.log(`  [${tag}] byte-scan (ClamAV delegate)`);
    console.log(`      ${c.dim}${scan.detail}${c.reset}`);
  } else {
    console.log(
      `  ${c.dim}byte-scan: not run (pass --scan-bytes to delegate to a local ClamAV)${c.reset}`,
    );
  }
  console.log(
    overallPass
      ? `${c.green}pass${c.reset} — no code-execution-on-load format${scan?.verdict === "clean" ? " + ClamAV clean" : ""} (still verify provenance + load in a sandbox)`
      : scan?.verdict === "malicious"
        ? `${c.red}fail${c.reset} — ClamAV matched a known-malware signature; do not load`
        : `${c.red}fail${c.reset} — code-execution-on-load risk; do not load an untrusted file`,
  );
  return overallPass;
}
