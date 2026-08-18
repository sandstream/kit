// `kit triage` commands — extracted from cli.ts (incremental split).
import { c } from "../utils/colors.js";
import { hasFlag, flagValue } from "../utils/flags.js";
import { runTriage, listTriageTools, type TriageType } from "../triage.js";
import { SKIPPED_COMMITS_LOG } from "../hooks.js";
import { triageMcpTools, extractToolDefs } from "../mcp-triage.js";
import { discoverPlugins } from "../agent-sbom.js";
import { scanPluginManifest, manifestHasHighRisk } from "../plugin-triage.js";
import { triageVaultConfig } from "../vault-triage.js";
import { triageModelArtifact } from "../model-artifact-triage.js";
import { existsSync, statSync } from "node:fs";

export async function cmdTriage(): Promise<boolean> {
  const args = process.argv.slice(3);
  const sandbox = hasFlag(args, "--sandbox");
  const deep = hasFlag(args, "--deep");
  const filtered = args.filter((a) => a !== "--sandbox" && a !== "--deep");
  const typeArg = filtered[0];
  // `check-deps` is a pre-commit subcommand handled below before we narrow
  // to TriageType; the rest of this function works against TriageType only.
  if (typeArg === "check-deps") {
    return cmdTriageCheckDeps();
  }
  if (typeArg === "check-skills") {
    return cmdTriageCheckSkills();
  }
  if (typeArg === "mcp") {
    return cmdTriageMcp(filtered.slice(1));
  }
  if (typeArg === "plugin") {
    return cmdTriagePlugin(filtered.slice(1));
  }
  if (typeArg === "vault-config") {
    return cmdTriageVaultConfig();
  }
  if (typeArg === "model") {
    return cmdTriageModel(filtered.slice(1));
  }
  const type = typeArg as TriageType;
  const target = filtered[1];

  if (!typeArg || typeArg === "--help" || typeArg === "-h") {
    console.log(`${c.bold}kit triage${c.reset} — Security evaluation before installing packages\n`);
    console.log("Usage:");
    console.log("  kit triage docker <image>           Evaluate Docker image (CVE + sandbox)");
    console.log("  kit triage npm <package>             Evaluate npm package (registry + GitHub)");
    console.log(
      "  kit triage npm <package> --sandbox   + offline tarball inspection (install-script + path-traversal scan, no code executed)",
    );
    console.log("  kit triage pip <package>             Evaluate PyPI package");
    console.log(
      "  kit triage brew <formula>            Evaluate Homebrew formula (resolves upstream repo, then repo-scores)",
    );
    console.log("  kit triage repo <github-url>         Evaluate GitHub repository");
    console.log(
      "  kit triage model <path>              Evaluate an untrusted AI artifact (model weights / dataset) before loading",
    );
    console.log(
      "  kit triage model <path> --scan-bytes + byte-level malware scan via a local ClamAV delegate (clean/malicious/gap; never a silent pass)",
    );
    console.log("  kit triage skill <path|name>         Evaluate Claude Code / agent skill");
    console.log(
      "  kit triage skill <path|name> --deep  + SkillSpector (NVIDIA) static Stage 1 (no LLM, no egress) when installed",
    );
    console.log(
      "  kit triage mcp <server> --tools <f>  Evaluate MCP tool metadata (poisoning) + pin against drift",
    );
    console.log(
      "  kit triage plugin [name]             Triage kitPlugins (npm supply-chain + manifest-poisoning scan); all declared if no name",
    );
    console.log(
      "  kit triage vault-config              Triage the secret-backend selection (.kit.toml secrets.store + per-key source); never reads secret values",
    );
    console.log("  kit triage all <target>              Auto-detect and run all checks");
    console.log("  kit triage tools                     Show installed security tools");
    console.log(
      "  kit triage check-deps                Pre-commit gate: fail if staged deps lack triage entries",
    );
    console.log(
      "  kit triage check-skills              Pre-commit gate: fail if staged skills lack a --deep triage entry",
    );
    console.log("");
    console.log("Examples:");
    console.log("  kit triage npm express");
    console.log("  kit triage npm node-ipc --sandbox");
    console.log("  kit triage docker stalwartlabs/stalwart");
    console.log("  kit triage skill searxng");
    return true;
  }

  const validTypes = ["docker", "npm", "pip", "brew", "repo", "skill", "all", "tools"];
  if (!validTypes.includes(type)) {
    console.error(`${c.red}Unknown triage type: ${type}${c.reset}`);
    console.error(`Valid types: ${validTypes.join(", ")}`);
    return false;
  }

  if (type === "tools") {
    const result = await listTriageTools();
    console.log(result.output);
    return true;
  }

  if (!target) {
    console.error(`${c.red}Target required for triage ${type}${c.reset}`);
    return false;
  }

  console.log(`${c.bold}Running triage on ${type}: ${target}${c.reset}\n`);
  const result = await runTriage(type as TriageType, target);
  console.log(result.output);

  // Sandbox is currently only meaningful for npm packages — extends the
  // registry-metadata check with offline tarball inspection.
  let sandboxClean = true;
  if (sandbox && type === "npm") {
    const { triageNpmSandbox } = await import("../triage-sandbox.js");
    console.log(`\n${c.bold}Sandbox inspection (offline):${c.reset}`);
    try {
      const sb = await triageNpmSandbox(target);
      console.log(`  package: ${sb.package}${sb.version ? `@${sb.version}` : ""}`);
      console.log(`  tarball: ${(sb.tarballSize / 1024).toFixed(1)} kB`);
      console.log(`  install scripts: ${sb.hasInstallScripts ? "YES (review below)" : "none"}`);
      if (sb.findings.length === 0) {
        console.log(`  ${c.green}✓ no risk signals${c.reset}`);
      } else {
        const critical = sb.findings.filter((f) => f.severity === "critical");
        if (critical.length > 0) sandboxClean = false;
        for (const f of sb.findings) {
          const tag =
            f.severity === "critical"
              ? `${c.red}[CRIT]${c.reset}`
              : f.severity === "warn"
                ? `${c.yellow}[WARN]${c.reset}`
                : `[info]`;
          console.log(`  ${tag} ${f.signal} — ${f.detail}`);
        }
      }
    } catch (err) {
      console.error(
        `  ${c.red}sandbox failed: ${err instanceof Error ? err.message : String(err)}${c.reset}`,
      );
      sandboxClean = false;
    }
  } else if (sandbox && type !== "npm") {
    console.log(
      `\n${c.dim}(--sandbox currently only applies to npm; ignored for ${type})${c.reset}`,
    );
  }

  // --deep on a skill: delegate to SkillSpector's STATIC Stage 1 (no LLM, no egress). Fail-closed.
  let deepClean = true;
  if (deep && type === "skill") {
    deepClean = await deepSkillScan(target);
  } else if (deep && type !== "skill") {
    console.log(
      `\n${c.dim}(--deep currently only applies to skill; ignored for ${type})${c.reset}`,
    );
  }

  const overall = result.passed && sandboxClean && deepClean;
  if (!overall) {
    console.log(`\n${c.yellow}⚠️  Review warnings above before proceeding.${c.reset}`);
  }

  // Record the triage outcome so the pre-commit triage-check can verify
  // that every newly added dep was evaluated. Failed runs aren't logged —
  // a failed triage means the user explicitly chose not to install, so it
  // shouldn't unblock the commit.
  if (overall && target) {
    await recordTriageRun(type, target, sandbox, deep);
  }

  return overall;
}

/**
 * `kit triage skill … --deep` helper: run SkillSpector's static Stage 1 (no LLM, no egress) and fold
 * its normalized findings into the verdict. Returns `false` only on a real high/critical finding or a
 * scan error; an ABSENT delegate is surfaced honestly and returns `true` (deep didn't run — the base
 * triage verdict still governs; kit never claims a deep-clean it didn't perform).
 */
async function deepSkillScan(target: string): Promise<boolean> {
  const { runSkillspectorStage1, SKILLSPECTOR_SOURCE } =
    await import("../skillspector-delegate.js");
  console.log(
    `\n${c.bold}Deep scan (${SKILLSPECTOR_SOURCE}, static — no LLM, no egress):${c.reset}`,
  );
  const deepRes = await runSkillspectorStage1(target);
  if (deepRes.status === "unavailable") {
    console.log(`  ${c.yellow}! ${deepRes.detail}${c.reset}`);
    return true;
  }
  if (deepRes.status === "error") {
    console.log(`  ${c.red}✗ deep scan errored: ${deepRes.detail}${c.reset}`);
    return false;
  }
  if (deepRes.findings.length === 0) {
    console.log(`  ${c.green}✓ no findings from the deep static scan${c.reset}`);
    return true;
  }
  for (const f of deepRes.findings) {
    const sev = f.severity ?? "info";
    const tag =
      sev === "critical" || sev === "high"
        ? `${c.red}[${sev.toUpperCase()}]${c.reset}`
        : `${c.yellow}[${sev}]${c.reset}`;
    console.log(`  ${tag} ${f.detail}`);
  }
  return !(deepRes.worst === "critical" || deepRes.worst === "high");
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

const MCP_PIN_FILE = ".kit-mcp-pins.json";

interface McpPin {
  hash: string;
  toolCount: number;
  pinnedAt: string;
}

/**
 * `kit triage mcp <server> --tools <manifest.json> [--pin]` — static MCP
 * tool-metadata triage (G3). Reads a tools/list manifest, runs kit's injection
 * detector over every tool description + parameter doc (tool poisoning), and
 * compares a stable content hash against a pinned one (rug-pull / drift). Exits
 * non-zero on high-confidence poisoning or a silent tool-definition change.
 * `--pin` records/updates the pin. Deterministic, zero-LLM.
 */
async function cmdTriageMcp(args: string[]): Promise<boolean> {
  const { readFile, writeFile } = await import("node:fs/promises");
  const { resolve } = await import("node:path");

  const server = args.find((a) => !a.startsWith("--"));
  const toolsPath = flagValue(process.argv, "--tools");
  const doPin = hasFlag(args, "--pin");
  if (!server || !toolsPath) {
    console.error(
      `${c.red}usage: kit triage mcp <server> --tools <manifest.json> [--pin]${c.reset}`,
    );
    console.error(
      `${c.dim}manifest = a tools/list response (or a JSON array of tool defs) for the server${c.reset}`,
    );
    return false;
  }

  let tools;
  try {
    const raw = await readFile(resolve(process.cwd(), toolsPath), "utf-8");
    tools = extractToolDefs(JSON.parse(raw));
  } catch (err) {
    console.error(
      `${c.red}could not read tool manifest ${toolsPath}: ${err instanceof Error ? err.message : err}${c.reset}`,
    );
    return false;
  }
  if (tools.length === 0) {
    console.error(`${c.red}no tool definitions found in ${toolsPath}${c.reset}`);
    return false;
  }

  const pinPath = resolve(process.cwd(), MCP_PIN_FILE);
  const pins = await readMcpPins(pinPath, readFile);
  const result = triageMcpTools(server, tools, pins[server]?.hash);

  console.log(`${c.bold}MCP triage: ${server}${c.reset} (${result.toolCount} tools)`);
  if (result.findings.length === 0) {
    console.log(`  ${c.green}✓ no tool-poisoning patterns${c.reset}`);
  } else {
    for (const f of result.findings) {
      const tag =
        f.confidence === "high" ? `${c.red}[HIGH]${c.reset}` : `${c.yellow}[heur]${c.reset}`;
      console.log(`  ${tag} ${f.tool} · ${f.field}: ${f.label}`);
    }
  }
  const driftMsg: Record<string, string> = {
    new: `${c.dim}new server — no prior pin${c.reset}`,
    unchanged: `${c.green}✓ tool set unchanged since pin${c.reset}`,
    changed: `${c.red}✗ RUG-PULL: tool set changed since pin${c.reset}`,
    unknown: `${c.dim}drift unknown${c.reset}`,
  };
  console.log(`  ${driftMsg[result.drift]}`);
  console.log(`  ${c.dim}hash ${result.toolsetHash.slice(0, 16)}…${c.reset}`);

  if (doPin) {
    pins[server] = {
      hash: result.toolsetHash,
      toolCount: result.toolCount,
      pinnedAt: new Date().toISOString(),
    };
    try {
      await writeFile(pinPath, JSON.stringify(pins, null, 2) + "\n", "utf-8");
      console.log(`  ${c.green}✓ pinned${c.reset}`);
    } catch (err) {
      console.error(
        `${c.red}could not write pin: ${err instanceof Error ? err.message : err}${c.reset}`,
      );
      return false;
    }
    // Pinning accepts the current state as trusted, so drift can't fail this run.
    return !result.findings.some((f) => f.confidence === "high");
  }

  if (!result.passed) {
    console.error(`${c.red}✗ MCP triage failed (poisoning or rug-pull) — review above${c.reset}`);
  }
  return result.passed;
}

async function readMcpPins(
  pinPath: string,
  readFile: (p: string, enc: "utf-8") => Promise<string>,
): Promise<Record<string, McpPin>> {
  try {
    return JSON.parse(await readFile(pinPath, "utf-8")) as Record<string, McpPin>;
  } catch {
    return {};
  }
}

const TRIAGE_LOG_FILE = ".kit-triage.jsonl";
/** A triage PASS counts as current for this long. Exported so every consumer reads ONE
 *  number: `check-deps` gates new manifest entries on it, and the "install-script grants"
 *  security check asks the same freshness question about a package granted install scripts.
 *  Two copies of a policy window drift, and the drift is silent. */
export const TRIAGE_MAX_AGE_DAYS = 7;

interface TriageLogEntry {
  timestamp: string;
  type: string;
  target: string;
  sandbox: boolean;
  /** Whether a deep delegate scan (SkillSpector Stage 1) ran — lets a gate require it for skills. */
  deep?: boolean;
  granter: string;
}

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
  cwd?: string,
): Promise<void> {
  const { appendFile } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  const entry: TriageLogEntry = {
    timestamp: new Date().toISOString(),
    type,
    target,
    sandbox,
    deep,
    granter: process.env.USER ?? "unknown",
  };
  try {
    await appendFile(
      resolve(cwd ?? process.cwd(), TRIAGE_LOG_FILE),
      JSON.stringify(entry) + "\n",
      "utf-8",
    );
  } catch (err) {
    console.error(
      `${c.dim}(triage-log append failed: ${err instanceof Error ? err.message : err})${c.reset}`,
    );
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

/** A staged path inside a skill directory: `.claude/skills/<name>/…`. Group 1 = skill name. */
const SKILL_PATH_RE = /^\.claude\/skills\/([^/]+)\/.+/;

/**
 * Parse `git diff --cached --name-only` output into the unique set of agent-skill names touched.
 * Only files *inside* a skill dir count; the bare `.claude/skills/<name>` dir entry never appears in
 * a name-only diff, so a skill is "staged" exactly when one of its files is.
 */
export function parseStagedSkillNames(files: string[]): string[] {
  const names = new Set<string>();
  for (const f of files) {
    const m = SKILL_PATH_RE.exec(f.trim());
    if (m) names.add(m[1]!);
  }
  return [...names];
}

/** Normalize a triage-log skill target (a path or a bare name) to its skill name (last segment). */
function skillTargetName(target: string): string {
  const trimmed = target.replace(/\/+$/, "");
  return trimmed.split("/").pop() || trimmed;
}

/**
 * Most-recent DEEP skill-triage timestamp (ms) per skill name, from the triage log. Only
 * `type:"skill"` entries with `deep === true` count — a shallow skill triage never satisfies the
 * deep gate. A forged/unparseable timestamp is dropped (it can't count as fresh). Pure.
 */
export function latestDeepSkillTriage(entries: TriageLogEntry[]): Map<string, number> {
  const latest = new Map<string, number>();
  for (const e of entries) {
    if (e.type !== "skill" || e.deep !== true) continue;
    const ts = Date.parse(e.timestamp);
    if (!Number.isFinite(ts)) continue; // fail-closed: garbage ts is never "fresh"
    const name = skillTargetName(e.target);
    const prev = latest.get(name);
    if (prev === undefined || ts > prev) latest.set(name, ts);
  }
  return latest;
}

/**
 * Pure gate core: which staged skills lack a fresh (≤ `maxAgeDays`) deep triage entry. A missing
 * entry, a shallow-only entry, or a stale/forged timestamp all count as "missing" (fail-closed).
 */
export function missingDeepSkillTriage(
  stagedSkillNames: string[],
  entries: TriageLogEntry[],
  nowMs: number,
  maxAgeDays = TRIAGE_MAX_AGE_DAYS,
): string[] {
  const latest = latestDeepSkillTriage(entries);
  const cutoff = nowMs - maxAgeDays * 24 * 3600 * 1000;
  const missing: string[] = [];
  for (const name of stagedSkillNames) {
    const ts = latest.get(name);
    if (ts === undefined || ts < cutoff) missing.push(name);
  }
  return missing;
}

/**
 * `kit triage check-skills` — pre-commit gate (increment 2b). Any agent skill with staged changes
 * under `.claude/skills/<name>/…` must have a `kit triage skill <name> --deep` entry in the triage
 * log within the last `TRIAGE_MAX_AGE_DAYS` days. A shallow triage does NOT satisfy the gate: agent
 * skills ship executable scripts, so the deep STATIC pass (SkillSpector Stage 1 — no LLM, no egress)
 * is required before they enter history. Fail-CLOSED: no log, a stale entry, or a shallow-only entry
 * all block the commit. Exits non-zero on any missing skill so the pre-commit hook fails.
 */
async function cmdTriageCheckSkills(): Promise<boolean> {
  const { execFileSync } = await import("node:child_process");
  const { readFile } = await import("node:fs/promises");
  const { resolve } = await import("node:path");

  let staged: string[];
  try {
    const out = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    staged = out.split("\n");
  } catch {
    return true; // not a git repo / nothing staged — nothing to gate
  }

  const skillNames = parseStagedSkillNames(staged);
  if (skillNames.length === 0) return true;

  const entries: TriageLogEntry[] = [];
  try {
    const text = await readFile(resolve(process.cwd(), TRIAGE_LOG_FILE), "utf-8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as TriageLogEntry);
      } catch {
        /* skip malformed line */
      }
    }
  } catch {
    /* no triage log yet — every staged skill is missing */
  }

  const missing = missingDeepSkillTriage(skillNames, entries, Date.now());
  if (missing.length === 0) return true;

  console.error(`${c.red}✗ Deep triage missing for ${missing.length} staged skill(s):${c.reset}`);
  for (const name of missing) {
    console.error(`  - ${name}  (run: kit triage skill ${name} --deep)`);
  }
  console.error("");
  console.error(
    `${c.dim}Agent skills ship executable scripts — the deep static scan (no LLM, no egress) is`,
  );
  console.error(
    `required before they enter history. Run the command(s) above, then re-stage and commit.`,
  );
  console.error(`Bypass with --no-verify is recorded to ${SKIPPED_COMMITS_LOG}.${c.reset}`);
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
export async function cmdTriageModel(args: string[]): Promise<boolean> {
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
