import { readFile, readdir, stat } from "node:fs/promises";
import { resolve, join, relative, sep } from "node:path";
import type { SecretFinding } from "./utils/redactSecrets.js";
import { ArtifactIncompleteError, findArtifactSecrets, MAX_BYTES } from "./scan-build-sourcemap.js";

/**
 * Walks built-artifact directories looking for leaked credentials. The
 * typical failure mode this catches is a Next.js `NEXT_PUBLIC_` typo that
 * silently inlines a server-only secret into the client bundle.
 *
 * Intentionally narrow in scope:
 *   - only known build-output dirs (no full-repo walk — that's what
 *     scanStagedFiles + checkSecretsInCode do)
 *   - skips obvious binary extensions
 *   - bounded per-file read at 5 MiB so a giant minified blob doesn't
 *     stall the scan
 */
export interface BuildHit {
  file: string;
  findings: SecretFinding[];
}

export interface BuildScanIssue {
  file: string;
  detail: string;
}

export class BuildScanIncompleteError extends Error {
  constructor(
    readonly issues: BuildScanIssue[],
    readonly hits: BuildHit[],
  ) {
    super(issues[0]?.detail ?? "build scan incomplete");
    this.name = "BuildScanIncompleteError";
  }
}

const DEFAULT_BUILD_DIRS = [
  ".next",
  "dist",
  "build",
  "out",
  ".vercel/output",
  ".svelte-kit",
  ".nuxt",
  ".output",
];

const SCANNABLE_EXTS = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".jsx",
  ".html",
  ".css",
  ".json",
  ".map",
  ".txt",
  ".rsc",
  ".body",
  ".env",
  ".env.local",
  ".env.production",
]);

const SKIP_DIRS = new Set(["node_modules", ".git", ".pnpm-store", "cache"]);

/** Next.js server modules are deployed to the runtime, not downloaded by visitors. */
function isBrowserVisibleNextArtifact(file: string): boolean {
  const parts = file.split("/");
  const nextIndex = parts.indexOf(".next");
  if (nextIndex === -1) return true;

  const output = parts.slice(nextIndex + 1);
  if (output[0] === "static") return true;
  if (output[0] !== "server" || !["app", "pages"].includes(output[1])) return false;

  // Prerendered responses in the server tree are served as page content.
  return /\.(?:html|rsc|body|json|txt)$/.test(file);
}

async function walk(dir: string, out: string[], depth = 0, maxDepth = 8): Promise<void> {
  if (depth > maxDepth) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (SKIP_DIRS.has(ent.name)) continue;
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      await walk(full, out, depth + 1, maxDepth);
    } else if (ent.isFile()) {
      const ext = ent.name.includes(".") ? ent.name.slice(ent.name.lastIndexOf(".")) : "";
      if (!SCANNABLE_EXTS.has(ext) && !ent.name.startsWith(".env")) continue;
      out.push(full);
    }
  }
}

export async function scanBuildArtifacts(
  cwd: string = process.cwd(),
  customDirs?: string[],
): Promise<BuildHit[]> {
  const dirsToScan = customDirs ?? DEFAULT_BUILD_DIRS;
  const files: string[] = [];

  for (const d of dirsToScan) {
    const full = resolve(cwd, d);
    try {
      const st = await stat(full);
      if (!st.isDirectory()) continue;
    } catch {
      continue;
    }
    await walk(full, files);
  }

  const hits: BuildHit[] = [];
  const incomplete: BuildScanIssue[] = [];
  for (const path of files) {
    const rel = relative(cwd, path).split(sep).join("/");
    if (!isBrowserVisibleNextArtifact(rel)) continue;
    let size: number;
    try {
      const st = await stat(path);
      size = st.size;
    } catch {
      if (rel.endsWith(".map"))
        incomplete.push({ file: rel, detail: `${rel}: source map could not be inspected` });
      continue;
    }
    if (size > MAX_BYTES) {
      if (rel.endsWith(".map"))
        incomplete.push({ file: rel, detail: `${rel}: source map exceeds 5 MiB` });
      continue;
    }
    let content: string;
    try {
      content = await readFile(path, "utf-8");
    } catch {
      if (rel.endsWith(".map"))
        incomplete.push({ file: rel, detail: `${rel}: source map could not be read` });
      continue;
    }
    let findings: SecretFinding[];
    try {
      findings = findArtifactSecrets(content, rel);
    } catch (error) {
      if (error instanceof ArtifactIncompleteError && error.findings.length) {
        hits.push({ file: rel, findings: error.findings });
      }
      incomplete.push({ file: rel, detail: `${rel}: ${(error as Error).message}` });
      continue;
    }
    if (findings.length > 0) {
      // Report repository-style paths so diagnostics and baselines are stable
      // across Windows and POSIX hosts.
      hits.push({ file: rel, findings });
    }
  }
  if (incomplete.length) throw new BuildScanIncompleteError(incomplete, hits);
  return hits;
}
