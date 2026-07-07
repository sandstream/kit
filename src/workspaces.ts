/**
 * Monorepo workspace resolution (#249).
 *
 * Source-rooted checks (test coverage, a11y/design scan) used to look only at
 * the repo root's src/app/components — in a Turborepo/pnpm monorepo the sources
 * live under apps/* and packages/*, so those checks returned an empty green.
 * "Scanned zero files" must never read as "scanned and found nothing wrong".
 *
 * Deterministic + local: reads `package.json` `workspaces` (array or {packages})
 * and `pnpm-workspace.yaml` `packages:` globs, expands single-`*` segments via
 * readdir, and keeps only directories that carry their own package.json.
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

/** Extract workspace glob patterns from package.json + pnpm-workspace.yaml. */
export function workspaceGlobs(cwd: string = process.cwd()): string[] {
  const globs: string[] = [];
  try {
    const pkg = JSON.parse(readFileSync(resolve(cwd, "package.json"), "utf8")) as {
      workspaces?: string[] | { packages?: string[] };
    };
    const ws = pkg.workspaces;
    if (Array.isArray(ws)) globs.push(...ws);
    else if (ws && Array.isArray(ws.packages)) globs.push(...ws.packages);
  } catch {
    // no package.json / unparseable — pnpm file below may still declare workspaces
  }
  try {
    const yaml = readFileSync(resolve(cwd, "pnpm-workspace.yaml"), "utf8");
    // Minimal YAML: lines like `  - "apps/*"` / `  - packages/*` under packages:.
    for (const line of yaml.split("\n")) {
      const m = line.match(/^\s*-\s*["']?([^"'#\s]+)["']?\s*$/);
      if (m) globs.push(m[1]);
    }
  } catch {
    // no pnpm workspace file
  }
  return [...new Set(globs.filter((g) => g && !g.startsWith("!")))];
}

/**
 * Resolve workspace globs to actual package directories (relative to cwd).
 * Supports the common shapes: literal dirs ("docs"), single-star ("apps/*")
 * and double-star treated as single level ("packages/**" → packages/<dir>).
 * A directory only counts as a workspace when it has its own package.json.
 */
export function resolveWorkspaceRoots(cwd: string = process.cwd()): string[] {
  const out = new Set<string>();
  for (const glob of workspaceGlobs(cwd)) {
    const starIdx = glob.indexOf("*");
    if (starIdx === -1) {
      if (existsSync(join(cwd, glob, "package.json"))) out.add(glob);
      continue;
    }
    const base = glob.slice(0, starIdx).replace(/\/$/, "");
    const baseDir = resolve(cwd, base);
    let entries: string[];
    try {
      entries = readdirSync(baseDir);
    } catch {
      continue;
    }
    for (const e of entries) {
      const rel = base ? `${base}/${e}` : e;
      try {
        if (!statSync(join(cwd, rel)).isDirectory()) continue;
      } catch {
        continue;
      }
      if (existsSync(join(cwd, rel, "package.json"))) out.add(rel);
    }
  }
  return [...out].sort();
}

/**
 * Expand root-level source dirs across workspaces: for each workspace, the
 * given dirs that exist under it (apps/web/src, packages/ui/components, …).
 * Returns [] when the repo has no workspaces — callers keep their root dirs.
 */
export function workspaceSourceDirs(
  cwd: string = process.cwd(),
  dirs: string[] = ["src", "app", "components"],
): string[] {
  const out: string[] = [];
  for (const ws of resolveWorkspaceRoots(cwd)) {
    for (const d of dirs) {
      if (existsSync(join(cwd, ws, d))) out.push(`${ws}/${d}`);
    }
  }
  return out;
}
