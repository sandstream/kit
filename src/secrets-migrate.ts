import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { SecretsConfig } from "./config.js";
import { scanPlaintextSecrets, type PlaintextHit } from "./scan-plaintext.js";
import { redactSecrets } from "./utils/redactSecrets.js";
import { writeViaBackend, type WriteResult } from "./secret-backends.js";

/**
 * Conservative env-var-style identifier check.
 *
 * Keys from `.env*` flow straight into CLI argv (e.g. `aws secretsmanager
 * create-secret --name <KEY>`). Without this guard a malicious or just
 * malformed file could smuggle in `--ignore-checks` or `-i` and have the
 * sink CLI reinterpret it as a flag. The shape we accept is exactly what
 * env-var parsers require: leading [A-Za-z_], rest [A-Za-z0-9_].
 */
export function isValidKeyName(key: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && key.length <= 128;
}

/** Escapes a string for safe embedding in a `new RegExp(...)` pattern. */
export function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Sanitizes the `err.message` we get from a child_process failure before
 * surfacing it to the user. execFile errors include the full argv on the
 * `cmd` property AND interpolate it into `err.message`, so a failed write
 * leaks the secret unless we redact. We keep the first line for diagnostic
 * value but strip anything matching a known secret pattern.
 */
function safeErrorMessage(err: unknown, knownSecrets: string[] = []): string {
  let raw = err instanceof Error ? err.message.split("\n")[0] : String(err);
  // Exact-substring redaction for values we hold — deterministic and
  // shape-independent. Pattern redaction alone fails open for lowercase-keyed
  // values, bare `--value <secret>` argv tokens, and URL-shaped secrets.
  for (const s of knownSecrets) {
    if (s) raw = raw.split(s).join("[REDACTED]");
  }
  // Pattern redaction as defense-in-depth for secret shapes we don't hold.
  return redactSecrets(raw);
}

export interface MigrationRecord {
  key: string;
  source: string; // file the key was read from
  vault: string; // backend store
  written: boolean;
  cleaned: boolean; // plaintext removed from source
  detail: string;
}

export interface MigrationPlan {
  hits: PlaintextHit[];
  /** Map of derived KEY-name → value as read from source file. */
  keyValues: Map<string, { value: string; source: string }>;
}

/**
 * Default .env files to scan. Mirrors the file list scan-plaintext.ts
 * targets but we walk them directly here so the plan includes EVERY
 * env-var-shaped KEY=VALUE pair, not only the ones whose value happens
 * to match a SECRET_PATTERN. Project-level configs like
 * `NEXT_PUBLIC_SUPABASE_URL`, `RESEND_FROM_EMAIL`, region/IDs etc. are
 * needed by the app even though they aren't credentials; the previous
 * secret-only filter dropped them and left the app non-functional after
 * migration.
 */
const ENV_FILES_TO_SCAN = [
  ".env",
  ".env.local",
  ".env.development",
  ".env.production",
  ".env.staging",
  ".env.test",
  ".env.preview",
];

export interface PlanMigrationOptions {
  /** Only include keys whose VALUE matches a credential pattern. Off by default. */
  secretsOnly?: boolean;
}

/**
 * Builds a migration plan by re-scanning for plaintext, then extracting
 * the actual VAR=VALUE pairs from .env-style files. Only KEY=VALUE lines
 * are migratable; embedded credentials inside scripts or JSON need manual
 * cleanup and are listed in the returned plan as `hits` only (no entry in
 * keyValues).
 */
export async function planMigration(
  cwd: string = process.cwd(),
  opts: PlanMigrationOptions = {},
): Promise<MigrationPlan> {
  const hits = await scanPlaintextSecrets(cwd);
  const keyValues = new Map<string, { value: string; source: string }>();

  for (const file of ENV_FILES_TO_SCAN) {
    let text: string;
    try {
      text = await readFile(resolve(cwd, file), "utf-8");
    } catch {
      continue;
    }
    for (const rawLine of text.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      // Strip simple quotes
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!value) continue;
      // Reject anything that isn't an env-var-shaped name — keeps `-x` /
      // `--something` style identifiers out of the migration plan before
      // they reach the sink CLI.
      if (!isValidKeyName(key)) continue;
      // Optional secrets-only filter — restores the historical behavior
      // for callers that explicitly want it. Default migrates everything
      // so vault becomes the single source of truth.
      if (opts.secretsOnly && redactSecrets(value) === value) continue;
      keyValues.set(key, { value, source: file });
    }
  }

  return { hits, keyValues };
}

/**
 * Writes a single key/value to the configured backend. Returns whether the
 * write succeeded. Per-backend create-or-update semantics live in the
 * {@link writeViaBackend} registry — this wrapper owns the cross-cutting
 * guards: read-only refusal, key-name validation, and error redaction.
 */
export async function writeSecretToBackend(
  store: SecretsConfig["store"],
  key: string,
  value: string,
  opts: { vault?: string; project?: string; region?: string; vaultPath?: string } = {},
): Promise<WriteResult> {
  // Read-only mode: refuse + audit-log before any backend touches the secret.
  const { isReadOnlyMode, refuseWrite } = await import("./read-only-mode.js");
  if (isReadOnlyMode()) {
    const refusal = await refuseWrite("write-secret-to-backend", {
      store,
      key,
    });
    return { ok: false, detail: refusal.reason };
  }
  // Reject anything that doesn't look like a normal env-var name BEFORE it
  // becomes argv. See isValidKeyName comment for rationale.
  if (!isValidKeyName(key)) {
    return {
      ok: false,
      detail: `invalid key name "${key}" — must match ^[A-Za-z_][A-Za-z0-9_]*$`,
    };
  }

  try {
    return await writeViaBackend(String(store), key, value, opts);
  } catch (err: unknown) {
    // Pass the plaintext value so a failed backend write can't leak it verbatim,
    // regardless of key casing or the flag shape the CLI used.
    return { ok: false, detail: `write failed: ${safeErrorMessage(err, [value])}` };
  }
}

/**
 * Post-migration treatment for a key's line in an .env-style file.
 *
 *   "blank"  — replace `KEY=value` with `KEY=` so the var name is still
 *              visible (devs see what's required) but the plaintext is
 *              gone. Default. Closes the silent-leak hole where a
 *              commented `# KEY=value` line still ships the secret to
 *              backups / agent transcripts / code review tools.
 *
 *   "comment" — `# migrated by kit → vault: KEY=value`. Preserves the
 *               original value for easy rollback. Use ONLY when you
 *               actively need to revert; pass `mode: "comment"` explicitly.
 *
 *   "delete" — drop the line entirely. Cleanest, but devs lose the
 *              required-var hint.
 */
export type PostMigrateMode = "blank" | "comment" | "delete";

export async function commentOutInFile(
  filePath: string,
  keys: string[],
  mode: PostMigrateMode = "blank",
): Promise<{ changed: number }> {
  let text: string;
  try {
    text = await readFile(filePath, "utf-8");
  } catch {
    return { changed: 0 };
  }
  let changed = 0;
  // Only act on env-var-shaped keys; same validation we use for writeSecretToBackend.
  const validKeys = keys.filter(isValidKeyName);
  const out: string[] = [];
  for (const line of text.split("\n")) {
    let matched = false;
    for (const key of validKeys) {
      // Key is regex-safe after isValidKeyName, but escape defensively in
      // case the validator is ever relaxed.
      const re = new RegExp(`^(\\s*)${escapeRegex(key)}\\s*=`);
      if (re.test(line)) {
        matched = true;
        changed++;
        if (mode === "delete") {
          // Skip the line entirely.
        } else if (mode === "comment") {
          out.push(`# migrated by kit → vault: ${line.replace(/^\s+/, "")}`);
        } else {
          // "blank" — keep KEY=, drop value. Preserve leading whitespace.
          const prefix = line.match(/^\s*/)?.[0] ?? "";
          out.push(`${prefix}${key}=  # value migrated to vault`);
        }
        break;
      }
    }
    if (!matched) out.push(line);
  }
  if (changed > 0) {
    await writeFile(filePath, out.join("\n"), "utf-8");
  }
  return { changed };
}
