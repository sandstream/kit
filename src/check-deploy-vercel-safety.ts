/**
 * Safety checks on the variables a Vercel project holds, read from the metadata the Vercel API
 * returns (key, type, targets, securityIssues; the value is never read). Three things fail a row:
 *
 * - a variable Vercel itself flags `readable-secret` (a secret stored in a form the dashboard can
 *   show), which is fixed by storing it again as `sensitive`;
 * - a secret held in ONE entry that targets both production and preview, so the two environments
 *   share a value (two separate entries cannot be compared, since the values are unreadable);
 * - a variable no source file names, which is dead weight at best and a forgotten credential at worst.
 *
 * The unread check is a text search of the repository, so it has a stated limit: a name that only a
 * library reads implicitly (NextAuth, Sentry) is listed in `implicit_env`, and a comment that names a
 * variable counts as reading it.
 */
import { readdirSync, type Dirent } from "node:fs";
import { extname, join } from "node:path";
import type { VercelDeployEnvironment } from "./config.js";
import { readRegularFileIfPresent } from "./upstream-safe-read.js";

export interface VercelEnvMeta {
  key: string;
  type?: string;
  targets: VercelDeployEnvironment[];
  securityIssues: string[];
}

export interface SafetyInput {
  vars: readonly VercelEnvMeta[];
  remoteEnv?: VercelDeployEnvironment;
  sharedOk: readonly string[];
  implicit: readonly string[];
  /** Names the deploy config already requires, so they are expected rather than unread. */
  declared: readonly string[];
  /** Names found in source, or null when there was nothing to search. */
  codeNames: ReadonlySet<string> | null;
}

export interface SafetyResult {
  readableSecret: string[];
  shared: string[];
  unread: string[];
  /** False when there was no code to search, so `unread` says nothing. */
  unreadChecked: boolean;
}

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const TARGETS = new Set(["production", "preview", "development"]);
const PUBLIC_NAME = /^(NEXT_PUBLIC_|PUBLIC_|VITE_|REACT_APP_|EXPO_PUBLIC_|NUXT_PUBLIC_)/;
const SECRET_NAME =
  /(SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|API_?KEY|SERVICE_ROLE|WEBHOOK|SALT|SIGNING)/;
const SYSTEM_NAME =
  /^(VERCEL_|__VERCEL|NX_|TURBO_|NEXT_RUNTIME$|NODE_ENV$|NODE_OPTIONS$|CI$|PORT$|TZ$)/;
const IMPLICIT_BUILTIN = new Set([
  "NEXTAUTH_SECRET",
  "NEXTAUTH_URL",
  "AUTH_SECRET",
  "AUTH_URL",
  "AUTH_TRUST_HOST",
  "SENTRY_AUTH_TOKEN",
  "SENTRY_ORG",
  "SENTRY_PROJECT",
  "NPM_TOKEN",
]);

function issueName(issue: unknown): string | null {
  if (typeof issue === "string") return issue;
  if (issue && typeof issue === "object") {
    const o = issue as Record<string, unknown>;
    for (const k of ["type", "id", "code", "name"])
      if (typeof o[k] === "string") return o[k] as string;
  }
  return null;
}

/** The variables of a Vercel env list, without their values. */
export function parseVercelEnvMeta(json: unknown): VercelEnvMeta[] {
  const envs =
    json && typeof json === "object" && Array.isArray((json as { envs?: unknown }).envs)
      ? ((json as { envs: unknown[] }).envs as unknown[])
      : Array.isArray(json)
        ? json
        : [];
  const out: VercelEnvMeta[] = [];
  for (const item of envs) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    if (typeof r.key !== "string" || !ENV_NAME.test(r.key)) continue;
    const targets = (
      Array.isArray(r.target) ? r.target : typeof r.target === "string" ? [r.target] : []
    ).filter((t): t is VercelDeployEnvironment => typeof t === "string" && TARGETS.has(t));
    const issues = (Array.isArray(r.securityIssues) ? r.securityIssues : [])
      .map(issueName)
      .filter((n): n is string => n !== null);
    out.push({
      key: r.key,
      type: typeof r.type === "string" ? r.type : undefined,
      targets,
      securityIssues: issues,
    });
  }
  return out;
}

function isSecretLike(v: VercelEnvMeta): boolean {
  if (PUBLIC_NAME.test(v.key)) return false;
  return (
    v.type === "sensitive" ||
    v.securityIssues.includes("readable-secret") ||
    SECRET_NAME.test(v.key)
  );
}

const unique = (names: Iterable<string>) => [...new Set(names)].sort();

export function evaluateVercelEnvSafety(input: SafetyInput): SafetyResult {
  const { remoteEnv } = input;
  const vars = input.vars.filter((v) => !remoteEnv || v.targets.includes(remoteEnv));
  const readableSecret = unique(
    vars.filter((v) => v.securityIssues.includes("readable-secret")).map((v) => v.key),
  );
  const sharedOk = new Set(input.sharedOk);
  const sharable = !remoteEnv || remoteEnv === "production" || remoteEnv === "preview";
  const shared = sharable
    ? unique(
        vars
          .filter((v) => v.targets.includes("production") && v.targets.includes("preview"))
          .filter((v) => isSecretLike(v) && !sharedOk.has(v.key))
          .map((v) => v.key),
      )
    : [];
  const expected = new Set([...input.implicit, ...input.declared]);
  const unreadChecked = input.codeNames !== null;
  const unread = unreadChecked
    ? unique(
        vars
          .map((v) => v.key)
          .filter(
            (k) =>
              !input.codeNames!.has(k) &&
              !SYSTEM_NAME.test(k) &&
              !IMPLICIT_BUILTIN.has(k) &&
              !expected.has(k),
          ),
      )
    : [];
  return { readableSecret, shared, unread, unreadChecked };
}

const SOURCE_EXT = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
  ".vue",
  ".svelte",
  ".astro",
  ".py",
  ".rb",
  ".go",
  ".php",
  ".prisma",
  ".json",
  ".toml",
  ".sh",
]);
const SKIPPED_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".next",
  ".vercel",
  ".turbo",
  "coverage",
  "out",
  "vendor",
  "target",
  ".git",
  ".github",
]);
const MAX_FILES = 5000;
const MAX_BYTES_TOTAL = 40 * 1024 * 1024;
const MAX_DEPTH = 8;
const NAME_TOKEN = /\b[A-Z][A-Z0-9_]+\b/g;

/**
 * Every upper-case name that appears in a source file under `root`, or null when there was no source
 * file to read. Env files, lockfiles, workflow files and vendored folders are left out: a name that
 * appears only in `.env.example` is documentation, not a read. A file is read as a regular file only.
 */
export function collectCodeEnvNames(root: string): Set<string> | null {
  const names = new Set<string>();
  const budget = { files: 0, bytes: 0 };
  const exhausted = () => budget.files >= MAX_FILES || budget.bytes >= MAX_BYTES_TOTAL;
  const walk = (rel: string, depth: number): void => {
    if (depth > MAX_DEPTH || exhausted()) return;
    for (const e of listFolder(join(root, rel))) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (isSearchedFolder(e.name)) walk(childRel, depth + 1);
      } else if (e.isFile() && isSourceFile(e.name)) {
        const text = readSource(join(root, childRel));
        if (text === null) continue;
        budget.files++;
        budget.bytes += text.length;
        for (const m of text.matchAll(NAME_TOKEN)) names.add(m[0]);
      }
      if (exhausted()) return;
    }
  };
  walk("", 0);
  return budget.files === 0 ? null : names;
}

function listFolder(path: string): Dirent[] {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

const isSearchedFolder = (name: string): boolean =>
  !SKIPPED_DIRS.has(name) && !name.startsWith(".");

const isSourceFile = (name: string): boolean =>
  !name.startsWith(".env") && !name.endsWith("lock.json") && SOURCE_EXT.has(extname(name));

function readSource(path: string): string | null {
  try {
    return readRegularFileIfPresent(path);
  } catch {
    return null;
  }
}

const list = (names: readonly string[]) => names.join(", ");

/** The detail text for what was found, and the way out of each. Never contains a value. */
export function describeSafety(r: SafetyResult): string {
  const parts: string[] = [];
  if (r.readableSecret.length > 0) {
    parts.push(
      `readable-secret: ${list(r.readableSecret)} (store each again as sensitive: kit secrets propagate <KEY> --to vercel)`,
    );
  }
  if (r.shared.length > 0) {
    parts.push(
      `shared between production and preview: ${list(r.shared)} (give each environment its own value, or list it under shared_ok)`,
    );
  }
  if (r.unread.length > 0) {
    parts.push(
      `not read by code: ${list(r.unread)} (remove it, or list it under implicit_env if a library reads it)`,
    );
  }
  return parts.join("; ");
}

/** The names a `[deploy.vercel]` table lists under an optional key, ignoring anything that is not a list of strings. */
export function configNames(provider: unknown, key: string): string[] {
  const value =
    provider && typeof provider === "object"
      ? (provider as Record<string, unknown>)[key]
      : undefined;
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

export interface RowAssessment {
  /** Text to append to the row's detail; empty when there is nothing to say. */
  detail: string;
  failed: boolean;
  unsafe?: { readableSecret?: string[]; shared?: string[]; unread?: string[] };
  unverified?: string[];
}

export interface RowInput {
  vars: readonly VercelEnvMeta[] | undefined;
  remoteEnv?: VercelDeployEnvironment;
  cwd: string;
  /** The `[deploy.vercel]` table, for `shared_ok` and `implicit_env`. */
  provider: unknown;
  declared: readonly string[];
  /** Source names per folder, so a project with several environments is searched once. */
  codeCache: Map<string, Set<string> | null>;
}

/** The three safety checks for one deploy row, or the plain statement that they could not run. */
export function assessVercelRow(input: RowInput): RowAssessment {
  if (input.vars === undefined) {
    return {
      detail: "type, target and security checks not run (they need VERCEL_TOKEN)",
      failed: false,
      unverified: ["readable-secret", "shared", "unread"],
    };
  }
  if (!input.codeCache.has(input.cwd))
    input.codeCache.set(input.cwd, collectCodeEnvNames(input.cwd));
  const r = evaluateVercelEnvSafety({
    vars: input.vars,
    remoteEnv: input.remoteEnv,
    sharedOk: configNames(input.provider, "shared_ok"),
    implicit: configNames(input.provider, "implicit_env"),
    declared: input.declared,
    codeNames: input.codeCache.get(input.cwd) ?? null,
  });
  const unsafe: NonNullable<RowAssessment["unsafe"]> = {};
  if (r.readableSecret.length > 0) unsafe.readableSecret = r.readableSecret;
  if (r.shared.length > 0) unsafe.shared = r.shared;
  if (r.unread.length > 0) unsafe.unread = r.unread;
  const failed = Object.keys(unsafe).length > 0;
  const notes = [describeSafety(r)];
  if (!r.unreadChecked) notes.push("not-read check skipped (no source file found to search)");
  return {
    detail: notes.filter(Boolean).join("; "),
    failed,
    ...(failed ? { unsafe } : {}),
    ...(r.unreadChecked ? {} : { unverified: ["unread"] }),
  };
}
