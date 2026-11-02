import { open, readdir, stat } from "node:fs/promises";
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

const MAX_DEPTH = 8;

async function walk(
  dir: string,
  root: string,
  out: string[],
  issues: BuildScanIssue[],
  depth = 0,
): Promise<void> {
  const rel = relative(root, dir).split(sep).join("/");
  if (depth > MAX_DEPTH) {
    issues.push({
      file: rel,
      detail: `${rel}: nested deeper than ${MAX_DEPTH} levels, not scanned`,
    });
    return;
  }
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    issues.push({ file: rel, detail: `${rel}: directory could not be read` });
    return;
  }
  for (const ent of entries) {
    if (SKIP_DIRS.has(ent.name)) continue;
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      await walk(full, root, out, issues, depth + 1);
    } else if (ent.isFile()) {
      const ext = ent.name.includes(".") ? ent.name.slice(ent.name.lastIndexOf(".")) : "";
      if (!SCANNABLE_EXTS.has(ext) && !ent.name.startsWith(".env")) continue;
      out.push(full);
    }
  }
}

/** Read at most MAX_BYTES + 1 bytes, so a file that grows after stat() cannot be read whole. */
async function readBounded(path: string): Promise<string | "too-large"> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return bytesRead > MAX_BYTES ? "too-large" : buffer.subarray(0, bytesRead).toString("utf-8");
  } finally {
    await handle.close();
  }
}

export async function scanBuildArtifacts(
  cwd: string = process.cwd(),
  customDirs?: string[],
): Promise<BuildHit[]> {
  const dirsToScan = customDirs ?? DEFAULT_BUILD_DIRS;
  const files: string[] = [];
  const incomplete: BuildScanIssue[] = [];

  for (const d of dirsToScan) {
    const full = resolve(cwd, d);
    try {
      const st = await stat(full);
      if (!st.isDirectory()) continue;
    } catch {
      continue;
    }
    await walk(full, cwd, files, incomplete);
  }

  const hits: BuildHit[] = [];
  for (const path of files) {
    const rel = relative(cwd, path).split(sep).join("/");
    if (!isBrowserVisibleNextArtifact(rel)) continue;
    let content: string | "too-large";
    try {
      content = await readBounded(path);
    } catch {
      incomplete.push({ file: rel, detail: `${rel}: file could not be read` });
      continue;
    }
    if (content === "too-large") {
      const kind = rel.endsWith(".map") ? "source map" : "file";
      incomplete.push({ file: rel, detail: `${rel}: ${kind} exceeds 5 MiB` });
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
