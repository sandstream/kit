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

/**
 * Registry spec allow-list: `name` or `name@version`, optionally scoped
 * (`@scope/name`). Anything else — git/http/file URLs, local dirs, .tgz paths —
 * is rejected before `npm pack` so a non-registry spec can't trigger arbitrary
 * code execution via prepare/prepack lifecycle scripts.
 */
const REGISTRY_SPEC = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(@[\w.\-+]+)?$/i;

/** Reject any spec npm would resolve to a non-registry source. */
export function isRegistrySpec(spec: string): boolean {
  if (!spec || spec.length > 214) return false;
  // No protocol (git+, http(s):, file:, git@host:), no leading path or dot.
  if (spec.includes(":") || spec.startsWith("/") || spec.startsWith(".")) return false;
  // No local tarball / git url / explicit protocol words.
  if (/\.tgz$|\.tar$|^git\b|^https?\b|^file\b/i.test(spec)) return false;
  return REGISTRY_SPEC.test(spec);
}

/**
 * Reject a tarball entry that would escape the package root or is a link.
 * Input is a single line from a verbose `tar -tvzf` listing, e.g.
 *   -rw-r--r--  0 u g  123 2020-01-01 00:00 package/index.js
 *   lrwxr-xr-x  0 u g    0 2020-01-01 00:00 package/evil -> /etc/passwd
 * The mode column's first char gives the entry type (l = symlink); the path is
 * the trailing field (before ` -> ` for links).
 */
export function isUnsafeEntry(line: string): boolean {
  const e = line.trim();
  if (!e) return false;

  // Symlink / hardlink: GNU and bsdtar both put the type flag first ('l' for
  // symlink, 'h' for hardlink). A link can repoint outside the package root.
  const typeFlag = e[0];
  if (typeFlag === "l" || typeFlag === "h") return true;

  // The archived path is the last field; for links, strip the ` -> target`.
  const path = (e.split(" -> ")[0].trim().split(/\s+/).pop() ?? "").trim();
  if (!path) return false;
  if (path.startsWith("/")) return true; // absolute
  if (path.split("/").some((seg) => seg === "..")) return true; // traversal
  if (/^[a-zA-Z]:[\\/]/.test(path)) return true; // windows drive-absolute
  return false;
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

  // Build a terminating result that surfaces accumulated findings (used by the
  // early-exit guards below) so the main flow stays flat.
  const stop = (extra: SandboxFinding, size = 0): SandboxResult => ({
    package: packageName,
    version: version ?? null,
    findings: [...findings, extra],
    hasInstallScripts: false,
    tarballSize: size,
  });

  // 0. Only registry specs are safe to pack. Git/dir/url/.tgz specs make
  //    `npm pack` run prepare/prepack lifecycle scripts = arbitrary code exec
  //    during the supposedly read-only inspection. Reject them outright.
  if (!isRegistrySpec(spec)) {
    return stop({
      severity: "critical",
      signal: "non-registry spec rejected",
      detail: `refusing to pack non-registry spec (only name[@version] allowed): ${spec}`,
    });
  }

  // 1. Pull the tarball offline. npm pack writes to cwd; use a tmpdir so we
  //    can clean up cleanly. --ignore-scripts (+ env var) prevents any
  //    lifecycle script from running while npm resolves/packs the spec.
  const work = await mkdtemp(join(tmpdir(), "kit-triage-"));
  let tarballPath = "";
  let tarballSize = 0;

  try {
    const { stdout } = await exec("npm", ["pack", spec, "--ignore-scripts", "--json", "--silent"], {
      cwd: work,
      timeout: 60_000,
      env: { ...process.env, npm_config_ignore_scripts: "true" },
    });
    const meta = JSON.parse(stdout)[0] as { filename: string; size: number; version?: string };
    tarballPath = join(work, meta.filename);
    tarballSize = meta.size;
    if (meta.version) version = meta.version;
  } catch (err) {
    return stop({
      severity: "warn",
      signal: "pack failed",
      detail: `npm pack ${spec}: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // 2. List entries BEFORE extracting. npm packs everything under "package/";
  //    any entry that escapes that root (absolute, "..", symlink/link) is
  //    malicious and must never be written to the inspecting host's fs.
  const listing = await listTarballEntries(tarballPath);
  findings.push(...listing.findings);
  if (!listing.ok) {
    // Listing failed or an entry escapes the root: never extract.
    return {
      package: packageName,
      version: version ?? null,
      findings,
      hasInstallScripts: false,
      tarballSize,
    };
  }

  // 3. Only now extract into the same tmpdir for inspection. Use the dash form
  //    `-xzf` (bsdtar on macOS rejects the bare `xzf` after long opts, which
  //    silently disabled the sandbox there).
  //    --no-same-owner/--no-same-permissions: archived ownership/mode bits must
  //    not carry over to the inspecting host (defense-in-depth).
  try {
    await exec(
      "tar",
      ["--no-same-owner", "--no-same-permissions", "-xzf", tarballPath, "-C", work],
      { timeout: 30_000 },
    );
  } catch (err) {
    return stop(
      {
        severity: "warn",
        signal: "extract failed",
        detail: `tar -xzf ${tarballPath}: ${err instanceof Error ? err.message : String(err)}`,
      },
      tarballSize,
    );
  }
  const pkgRoot = join(work, "package");

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

/**
 * List a tarball's entries (verbose, so the symlink/hardlink type flag is
 * visible) and flag any that escape the package root. Returns ok=false — with a
 * structured finding instead of throwing — when listing fails or an entry is
 * unsafe, so the caller can refuse to extract.
 */
async function listTarballEntries(
  tarballPath: string,
): Promise<{ ok: boolean; findings: SandboxFinding[] }> {
  const findings: SandboxFinding[] = [];
  let entries: string[];
  try {
    entries = (await exec("tar", ["-tvzf", tarballPath], { timeout: 10_000 })).stdout
      .split("\n")
      .filter(Boolean);
  } catch (err) {
    return {
      ok: false,
      findings: [
        {
          severity: "warn",
          signal: "tar list failed",
          detail: `tar -tvzf ${tarballPath}: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }
  let ok = true;
  for (const entry of entries) {
    if (isUnsafeEntry(entry)) {
      ok = false;
      findings.push({
        severity: "critical",
        signal: "path traversal",
        detail: `tarball entry escapes package root: ${entry}`,
      });
    }
  }
  return { ok, findings };
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
