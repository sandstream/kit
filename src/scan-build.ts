import { readFile, readdir, stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { findSecrets, type SecretFinding } from "./utils/redactSecrets.js";

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
  ".env",
  ".env.local",
  ".env.production",
]);

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".pnpm-store",
  "cache",
]);

const MAX_BYTES = 5 * 1024 * 1024; // 5 MiB

async function walk(
  dir: string,
  out: string[],
  depth = 0,
  maxDepth = 8,
): Promise<void> {
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
      const ext = ent.name.includes(".")
        ? ent.name.slice(ent.name.lastIndexOf("."))
        : "";
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
  for (const path of files) {
    let content: string;
    try {
      const st = await stat(path);
      if (st.size > MAX_BYTES) continue;
      content = await readFile(path, "utf-8");
    } catch {
      continue;
    }
    const findings = findSecrets(content);
    if (findings.length > 0) {
      // Strip leading cwd from path for readable reporting.
      const rel = path.startsWith(cwd) ? path.slice(cwd.length + 1) : path;
      hits.push({ file: rel, findings });
    }
  }
  return hits;
}
