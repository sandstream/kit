// `kit triage` commands — extracted from cli.ts (incremental split).
import { c } from "../utils/colors.js";
import { hasFlag } from "../utils/flags.js";
import { runTriage, listTriageTools, type TriageType } from "../triage.js";
import { SKIPPED_COMMITS_LOG } from "../hooks.js";

export async function cmdTriage(): Promise<boolean> {
  const args = process.argv.slice(3);
  const sandbox = hasFlag(args, "--sandbox");
  const filtered = args.filter((a) => a !== "--sandbox");
  const typeArg = filtered[0];
  // `check-deps` is a pre-commit subcommand handled below before we narrow
  // to TriageType; the rest of this function works against TriageType only.
  if (typeArg === "check-deps") {
    return cmdTriageCheckDeps();
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
    console.log("  kit triage skill <path|name>         Evaluate Claude Code / agent skill");
    console.log("  kit triage all <target>              Auto-detect and run all checks");
    console.log("  kit triage tools                     Show installed security tools");
    console.log(
      "  kit triage check-deps                Pre-commit gate: fail if staged deps lack triage entries",
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

  const overall = result.passed && sandboxClean;
  if (!overall) {
    console.log(`\n${c.yellow}⚠️  Review warnings above before proceeding.${c.reset}`);
  }

  // Record the triage outcome so the pre-commit triage-check can verify
  // that every newly added dep was evaluated. Failed runs aren't logged —
  // a failed triage means the user explicitly chose not to install, so it
  // shouldn't unblock the commit.
  if (overall && target) {
    await recordTriageRun(type, target, sandbox);
  }

  return overall;
}

const TRIAGE_LOG_FILE = ".kit-triage.jsonl";
const TRIAGE_MAX_AGE_DAYS = 7;

interface TriageLogEntry {
  timestamp: string;
  type: string;
  target: string;
  sandbox: boolean;
  granter: string;
}

async function recordTriageRun(type: string, target: string, sandbox: boolean): Promise<void> {
  const { appendFile } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  const entry: TriageLogEntry = {
    timestamp: new Date().toISOString(),
    type,
    target,
    sandbox,
    granter: process.env.USER ?? "unknown",
  };
  try {
    await appendFile(
      resolve(process.cwd(), TRIAGE_LOG_FILE),
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
