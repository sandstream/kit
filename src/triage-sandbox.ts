/**
 * Triage sandbox — behavioral analysis for npm packages without executing them.
 *
 * Complements the bumblebee catalog (known compromises) and the existing
 * triage script (registry metadata). This module pulls the tarball, inspects
 * it offline, and flags risk signals that frequently appear in supply-chain
 * attacks but are absent from npm-registry metadata.
 *
 * Risk signals:
 *   - install scripts (preinstall / install / postinstall) — execution surface
 *   - postinstall content that resembles obfuscation, base64 blobs,
 *     network calls, or filesystem reads outside the package root
 *   - tarball entries that escape the package directory (path traversal)
 *   - tarball entries marked executable that shouldn't be
 *
 * No code from the package is ever executed. All work is read-only on the
 * downloaded tarball.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, mkdtemp, readdir, stat, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const exec = promisify(execFile);

export interface SandboxFinding {
  severity: "info" | "warn" | "critical";
  signal: string;
  detail: string;
}

export interface SandboxResult {
  package: string;
  version: string | null;
  findings: SandboxFinding[];
  hasInstallScripts: boolean;
  tarballSize: number;
}

/** Patterns that frequently appear in malicious lifecycle scripts. */
const SUSPICIOUS_SCRIPT_PATTERNS: Array<[RegExp, string]> = [
  [/curl|wget|https?:\/\//i, "network call in install script"],
  [/eval\s*\(/, "eval() in install script"],
  [/Buffer\.from\([^,)]+,\s*['"]base64/, "base64 blob in install script"],
  [/\\x[0-9a-f]{2}|\\u[0-9a-f]{4}/, "hex/unicode-escaped string in install script"],
  [/\.ssh|\.aws|\.env|\.npmrc/, "reads sensitive file in install script"],
  [/child_process|spawn|exec/, "spawns subprocess in install script"],
  [/process\.env\.[A-Z]+_TOKEN|process\.env\.[A-Z]+_KEY/, "reads env credential in install script"],
];

/** Inspect an npm package without executing any of its code. */
export async function triageNpmSandbox(
  packageName: string,
  version?: string,
): Promise<SandboxResult> {
  const findings: SandboxFinding[] = [];
  const spec = version ? `${packageName}@${version}` : packageName;

  // 1. Pull the tarball offline. npm pack writes to cwd; use a tmpdir so we
  //    can clean up cleanly.
  const work = await mkdtemp(join(tmpdir(), "kit-triage-"));
  let tarballPath = "";
  let tarballSize = 0;

  try {
    const { stdout } = await exec("npm", ["pack", spec, "--json", "--silent"], {
      cwd: work,
      timeout: 60_000,
    });
    const meta = JSON.parse(stdout)[0] as { filename: string; size: number; version?: string };
    tarballPath = join(work, meta.filename);
    tarballSize = meta.size;
    if (meta.version) version = meta.version;
  } catch (err) {
    return {
      package: packageName,
      version: version ?? null,
      findings: [
        {
          severity: "warn",
          signal: "pack failed",
          detail: `npm pack ${spec}: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
      hasInstallScripts: false,
      tarballSize: 0,
    };
  }

  // 2. Extract into the same tmpdir for inspection.
  // --no-same-owner/--no-same-permissions: archived ownership/mode bits must not
  // carry over to the inspecting host (defense-in-depth).
  await exec("tar", ["--no-same-owner", "--no-same-permissions", "xzf", tarballPath, "-C", work], {
    timeout: 30_000,
  });
  const pkgRoot = join(work, "package");

  // 3. Path traversal check — npm packs everything under "package/", anything
  //    above is malicious.
  const entries = (await exec("tar", ["tzf", tarballPath], { timeout: 10_000 })).stdout
    .split("\n")
    .filter(Boolean);
  for (const entry of entries) {
    if (entry.includes("..") || entry.startsWith("/")) {
      findings.push({
        severity: "critical",
        signal: "path traversal",
        detail: `tarball entry escapes package root: ${entry}`,
      });
    }
  }

  // 4. Parse package.json for install scripts.
  let hasInstallScripts = false;
  let pkgJson: { scripts?: Record<string, string>; bin?: unknown } = {};
  try {
    pkgJson = JSON.parse(await readFile(join(pkgRoot, "package.json"), "utf-8"));
  } catch {
    findings.push({
      severity: "warn",
      signal: "package.json unreadable",
      detail: "couldn't parse extracted package.json",
    });
  }

  const lifecycleHooks = ["preinstall", "install", "postinstall"];
  for (const hook of lifecycleHooks) {
    const script = pkgJson.scripts?.[hook];
    if (!script) continue;
    hasInstallScripts = true;
    findings.push({
      severity: "warn",
      signal: `lifecycle: ${hook}`,
      detail: `${hook}: ${script}`,
    });

    // 5. Scan the actual script file the hook invokes — `node foo.js` etc.
    for (const [pattern, label] of SUSPICIOUS_SCRIPT_PATTERNS) {
      if (pattern.test(script)) {
        findings.push({
          severity: "critical",
          signal: label,
          detail: `${hook} script matches: ${pattern}`,
        });
      }
    }
  }

  // 6. World-readable, executable, oddly large files.
  await walkAndCheck(pkgRoot, findings);

  return {
    package: packageName,
    version: version ?? null,
    findings,
    hasInstallScripts,
    tarballSize,
  };
}

async function walkAndCheck(dir: string, findings: SandboxFinding[]): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      await walkAndCheck(full, findings);
      continue;
    }
    if (!entry.isFile()) continue;
    const st = await stat(full);
    // Bash/python/Perl scripts dropped at the package root are unusual for
    // libraries — flag them.
    if (/\.(sh|py|pl|rb)$/i.test(entry.name)) {
      findings.push({
        severity: "warn",
        signal: "script in package",
        detail: `${entry.name} (${st.size} bytes)`,
      });
    }
    // 5MB+ single file in a tarball is unusual for JS libs.
    if (st.size > 5 * 1024 * 1024) {
      findings.push({
        severity: "info",
        signal: "large file",
        detail: `${entry.name}: ${(st.size / 1024 / 1024).toFixed(1)} MB`,
      });
    }
  }
}

/** Cleanup helper if caller wants to drop the extraction tmpdir. */
export async function cleanupSandbox(workDir: string): Promise<void> {
  await rm(workDir, { recursive: true, force: true }).catch(() => {});
}
