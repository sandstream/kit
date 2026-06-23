import { readFile, readdir, access, stat, realpath } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { resolve, join, relative } from "node:path";
import { findSecrets, type SecretFinding } from "./utils/redactSecrets.js";

export interface PlaintextHit {
  file: string;
  findings: SecretFinding[];
}

export interface PlaintextScanOptions {
  /** Additional file paths (relative to cwd) to scan beyond the defaults. */
  extraFiles?: string[];
  /** Additional dirs to walk recursively (depth-limited). Defaults to common config homes. */
  extraDirs?: string[];
  /** Max directory recursion depth. Default 3. Walk skips node_modules/.git/dist/build/out. */
  maxDepth?: number;
  /** Override the entire default list — useful for `.kit.toml` config. */
  overrideFiles?: string[];
  overrideDirs?: string[];
}

const DEFAULT_FILE_NAMES = [
  ".env",
  ".env.local",
  ".env.development",
  ".env.production",
  ".env.staging",
  ".env.test",
  ".env.preview",
  ".envrc",
  "package.json",
  "vercel.json",
  "fly.toml",
  "railway.toml",
  "wrangler.toml",
  "netlify.toml",
  "render.yaml",
  "docker-compose.yml",
  "docker-compose.yaml",
  "terraform.tfvars",
  "terraform.tfvars.json",
];

const DEFAULT_RECURSIVE_DIRS = ["scripts", "config", "infra", "terraform", ".github"];

const RECURSIVE_FILE_EXTS = /\.(sh|js|ts|mjs|cjs|json|yml|yaml|toml|tf|tfvars|tfstate|env)$/;

const SKIP_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  ".turbo",
  ".cache",
  "coverage",
  ".venv",
  "venv",
  "__pycache__",
  ".kit", // own state
]);

/**
 * Scan high-signal locations for plaintext secrets before the user moves
 * to a vault. Widened in P2: recurses into named config dirs (depth-limited),
 * skips obvious build artifacts/node_modules, follows symlinks safely
 * (resolves real path + dedupes), and accepts caller-supplied include lists
 * so `.kit.toml` can extend the defaults per-project.
 */
export async function scanPlaintextSecrets(
  cwd: string = process.cwd(),
  opts: PlaintextScanOptions = {},
): Promise<PlaintextHit[]> {
  const hits: PlaintextHit[] = [];
  const seenRealPaths = new Set<string>();

  const fileTargets = opts.overrideFiles ?? [...DEFAULT_FILE_NAMES, ...(opts.extraFiles ?? [])];
  const dirTargets = opts.overrideDirs ?? [...DEFAULT_RECURSIVE_DIRS, ...(opts.extraDirs ?? [])];
  const maxDepth = opts.maxDepth ?? 3;

  const scanFile = async (relativePath: string, absolutePath: string) => {
    let realPath: string;
    try {
      realPath = await realpath(absolutePath);
    } catch {
      return;
    }
    if (seenRealPaths.has(realPath)) return;
    seenRealPaths.add(realPath);
    try {
      const info = await stat(realPath);
      if (!info.isFile()) return;
      // Refuse to slurp anything huge — kit isn't a full secret scanner.
      if (info.size > 5 * 1024 * 1024) return;
    } catch {
      return;
    }
    try {
      const text = await readFile(realPath, "utf-8");
      const findings = findSecrets(text);
      if (findings.length > 0) {
        hits.push({ file: relativePath, findings });
      }
    } catch {
      /* unreadable / binary — skip */
    }
  };

  // Pass 1: named files at repo root.
  for (const name of fileTargets) {
    const absolute = resolve(cwd, name);
    try {
      await access(absolute);
    } catch {
      continue;
    }
    await scanFile(name, absolute);
  }

  // Pass 2: depth-limited walk of the configured dirs.
  for (const dirName of dirTargets) {
    const root = resolve(cwd, dirName);
    try {
      await access(root);
    } catch {
      continue;
    }
    await walk(root, 0);
  }

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    let entries: Dirent[];
    try {
      entries = (await readdir(dir, { withFileTypes: true })) as unknown as Dirent[];
    } catch {
      return;
    }
    for (const ent of entries) {
      if (SKIP_DIR_NAMES.has(ent.name)) continue;
      const childAbs = join(dir, ent.name);
      const childRel = relative(cwd, childAbs);
      if (ent.isDirectory()) {
        await walk(childAbs, depth + 1);
        continue;
      }
      if (!ent.isFile() && !ent.isSymbolicLink()) continue;
      // Only match the known-noisy extensions to keep the scan fast.
      // .tfstate is intentionally included even though it's huge in some
      // repos — the size guard above caps the slurp.
      if (!RECURSIVE_FILE_EXTS.test(ent.name)) continue;
      await scanFile(childRel, childAbs);
    }
  }

  return hits;
}
