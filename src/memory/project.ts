/**
 * kit memory — current-project resolution.
 *
 * Memory search defaults to the current project (relevance + blast-radius
 * containment); the repo root is the project boundary. Falls back to cwd when not
 * inside a git repo. Pure read — no model calls, no writes.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, posix, resolve, win32 } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { parse } from "smol-toml";

const PROJECT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export interface ProjectIdentityInitialization {
  id: string;
  root: string;
  path: string;
  created: boolean;
}

function projectRoot(path: string): string {
  const local = resolveLocalProjectPath(path);
  return resolveLocalProjectPath(getCurrentProjectRoot(local));
}

/** Explicit checked-in identity. Association only: it is public, not authentication. */
export function getProjectIdentity(path: string): { id: string; root: string } | null {
  const root = projectRoot(path);
  try {
    const config = parse(readFileSync(resolve(root, ".kit.toml"), "utf8")) as Record<
      string,
      unknown
    >;
    const memory = config.memory as Record<string, unknown> | undefined;
    const id = typeof memory?.project_id === "string" ? memory.project_id.trim() : "";
    if (!PROJECT_ID.test(id)) return null;
    return { id: id.toLowerCase(), root };
  } catch {
    return null;
  }
}

function configWithProjectIdentity(source: string, id: string): string {
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const assignment = `project_id = "${id}"`;
  const memoryHeader = /^\s*\[memory\]\s*(?:#.*)?$/m;
  const nestedMemoryHeader = /^\s*\[memory\.[^\]]+\]\s*(?:#.*)?$/m;

  if (memoryHeader.test(source)) {
    return source.replace(memoryHeader, (header) => `${header}${newline}${assignment}`);
  }
  const nested = nestedMemoryHeader.exec(source);
  if (nested?.index !== undefined) {
    return `${source.slice(0, nested.index)}[memory]${newline}${assignment}${newline}${newline}${source.slice(nested.index)}`;
  }
  const separator =
    source.length === 0 ? "" : source.endsWith(newline) ? newline : `${newline}${newline}`;
  return `${source}${separator}[memory]${newline}${assignment}${newline}`;
}

/** Create the checked-in cross-clone association once; never rotate an existing identity. */
export function initializeProjectIdentity(path: string): ProjectIdentityInitialization {
  const root = projectRoot(path);
  const configPath = resolve(root, ".kit.toml");
  if (existsSync(configPath) && lstatSync(configPath).isSymbolicLink()) {
    throw new Error(`Refusing to update symlinked project config: ${configPath}`);
  }

  const source = existsSync(configPath) ? readFileSync(configPath, "utf8") : "version = 1\n";
  let parsed: Record<string, unknown>;
  try {
    parsed = parse(source) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `Cannot initialize project identity because ${configPath} is invalid TOML: ${(err as Error).message}`,
      { cause: err },
    );
  }
  const memory = parsed.memory as Record<string, unknown> | undefined;
  if (memory?.project_id !== undefined) {
    const existing = typeof memory.project_id === "string" ? memory.project_id.trim() : "";
    if (!PROJECT_ID.test(existing)) {
      throw new Error(`Invalid existing [memory].project_id in ${configPath}; expected a UUID.`);
    }
    return { id: existing.toLowerCase(), root, path: configPath, created: false };
  }

  const id = randomUUID();
  const content = configWithProjectIdentity(source, id);
  // Validate the exact output before publication; malformed input never becomes a partial config.
  parse(content);
  const mode = existsSync(configPath) ? lstatSync(configPath).mode & 0o777 : 0o600;
  const temporary = `${configPath}.kit-tmp-${process.pid}-${randomUUID()}`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", mode);
    writeFileSync(fd, content, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    chmodSync(temporary, mode);
    renameSync(temporary, configPath);
  } catch (err) {
    if (fd !== undefined) closeSync(fd);
    rmSync(temporary, { force: true });
    throw err;
  }
  return { id, root, path: configPath, created: true };
}

export function prepareProjectIdentities(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS memory_projects (
    project_id TEXT NOT NULL,
    project_path TEXT NOT NULL,
    observed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (project_id, project_path)
  )`);
}

export function registerProjectIdentity(db: DatabaseSync, path: string | null | undefined): void {
  if (!path) return;
  const identity = getProjectIdentity(path);
  if (!identity) return;
  prepareProjectIdentities(db);
  const remember = db.prepare(
    `INSERT INTO memory_projects (project_id, project_path, observed_at)
     VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(project_id, project_path) DO UPDATE SET observed_at=excluded.observed_at`,
  );
  const observedRoot = resolve(getCurrentProjectRoot(resolve(path)));
  for (const root of new Set([observedRoot, identity.root])) remember.run(identity.id, root);
}

export function mergeProjectIdentities(target: DatabaseSync, source: DatabaseSync): void {
  const exists = source
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_projects'")
    .get();
  if (!exists) return;
  prepareProjectIdentities(target);
  const insert = target.prepare(
    "INSERT OR IGNORE INTO memory_projects (project_id, project_path, observed_at) VALUES (?, ?, ?)",
  );
  for (const row of source.prepare("SELECT * FROM memory_projects").iterate()) {
    const id = typeof row.project_id === "string" ? row.project_id.toLowerCase() : "";
    const path = typeof row.project_path === "string" ? row.project_path : "";
    if (!PROJECT_ID.test(id) || (!posix.isAbsolute(path) && !win32.isAbsolute(path))) continue;
    insert.run(id, path, typeof row.observed_at === "string" ? row.observed_at : null);
  }
}

/** Canonicalize existing ancestors as well, so a not-yet-cloned destination is stable. */
export function resolveLocalProjectPath(path: string): string {
  let ancestor = resolve(path);
  const suffix: string[] = [];
  for (;;) {
    try {
      return resolve(realpathSync(ancestor), ...suffix);
    } catch {
      const parent = dirname(ancestor);
      if (parent === ancestor) return resolve(path);
      suffix.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
}

export function getCurrentProjectRoot(cwd: string = process.cwd()): string {
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (root) return root;
  } catch {
    // not a git repo (or git unavailable) — fall back to cwd
  }
  return cwd;
}

/** Expand recall only to Git-registered worktrees, never unrelated clones with the same name. */
export function getProjectRecallRoots(projectPath: string, db?: DatabaseSync): string[] {
  const canonical = resolveLocalProjectPath(projectPath);
  const localRoots = [...new Set([projectPath, canonical])];
  const identity = getProjectIdentity(canonical);
  if (identity && db) {
    try {
      const registered = db
        .prepare("SELECT project_path FROM memory_projects WHERE project_id=?")
        .all(identity.id)
        .map((row) => String(row.project_path));
      localRoots.push(identity.root, ...registered);
    } catch {
      // Older read-only stores have no identity registry; retain path-only recall.
    }
  }
  try {
    // An explicitly scoped subdirectory must not silently expand to the whole repository.
    if (resolve(getCurrentProjectRoot(canonical)) !== canonical) return localRoots;
    const records = execFileSync("git", ["worktree", "list", "--porcelain", "-z"], {
      cwd: canonical,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    });
    const roots = records
      .split("\0")
      .filter((field) => field.startsWith("worktree "))
      .map((field) => field.slice("worktree ".length));
    return [...new Set([...localRoots, ...roots])];
  } catch {
    return localRoots;
  }
}
