import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { appendAuditEventDirect } from "./audit.js";

/**
 * Tracks the active environment ("dev" / "staging" / "prod") on disk so the
 * rest of kit can refuse to materialize prod-scoped credentials when the
 * developer is sitting in `dev`. The marker lives under `.kit/` because
 * `.kit.toml` is meant to be project config (checkable into git), while
 * the active env is per-developer state (gitignored).
 */

export type kitEnv = "dev" | "staging" | "prod";

export const KNOWN_ENVS: kitEnv[] = ["dev", "staging", "prod"];

export const ACTIVE_ENV_FILE = ".kit/active-env.json";

export interface ActiveEnvState {
  env: kitEnv;
  switchedAt: string; // ISO timestamp
  switchedBy: string; // user / agent identifier
}

export async function readActiveEnv(
  cwd: string = process.cwd(),
): Promise<ActiveEnvState | null> {
  const path = resolve(cwd, ACTIVE_ENV_FILE);
  try {
    await access(path);
    const text = await readFile(path, "utf-8");
    const parsed = JSON.parse(text) as Partial<ActiveEnvState>;
    if (!parsed.env || !KNOWN_ENVS.includes(parsed.env as kitEnv)) {
      return null;
    }
    return {
      env: parsed.env as kitEnv,
      switchedAt: parsed.switchedAt ?? new Date().toISOString(),
      switchedBy: parsed.switchedBy ?? "unknown",
    };
  } catch {
    return null;
  }
}

export async function writeActiveEnv(
  env: kitEnv,
  cwd: string = process.cwd(),
  switchedBy: string = process.env.USER || "unknown",
): Promise<ActiveEnvState> {
  const state: ActiveEnvState = {
    env,
    switchedAt: new Date().toISOString(),
    switchedBy,
  };
  const path = resolve(cwd, ACTIVE_ENV_FILE);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2) + "\n", "utf-8");
  return state;
}

/**
 * Returns the active env if set; defaults to "dev" so a project that hasn't
 * opted into env-switching yet behaves safely (no accidental prod-key reads).
 */
export async function getActiveEnv(
  cwd: string = process.cwd(),
): Promise<kitEnv> {
  const state = await readActiveEnv(cwd);
  return state?.env ?? "dev";
}

/**
 * Returns true if the caller is allowed to read prod-scoped secrets in the
 * current shell. Two gates: the active env must be "prod" AND either an
 * interactive confirmation has happened OR `KIT_PROD_OK=1` was set
 * explicitly (suitable for CI deploy jobs).
 *
 * When `KIT_PROD_OK=1` authorizes the read, a one-time stderr warning is
 * emitted at the call site (not at the eventual secrets-resolve step) and an
 * audit event is appended. This closes the previous gap where the warning
 * only printed AFTER the prod credential had already been materialized.
 */
let warnedAboutProdOk = false;
function warnProdOkOnce(cwd: string): void {
  if (warnedAboutProdOk) return;
  warnedAboutProdOk = true;
  console.error(
    "[kit] WARNING: KIT_PROD_OK=1 active — prod credentials authorized for read in this process.",
  );
  void appendAuditEventDirect(
    {
      operation: "prod-key-bypass",
      environment: "prod",
      success: true,
      metadata: {
        method: "KIT_PROD_OK=1",
        granter: process.env.USER ?? "unknown",
      },
    },
    { cwd },
  );
}

export function prodReadAllowed(
  activeEnv: kitEnv,
  opts: { explicitOk?: boolean; cwd?: string } = {},
): boolean {
  if (activeEnv !== "prod") return false;
  if (opts.explicitOk) return true;
  if (process.env.KIT_PROD_OK === "1") {
    warnProdOkOnce(opts.cwd ?? process.cwd());
    return true;
  }
  return false;
}

/**
 * Test-only: reset the module-scoped "warned-once" flag so tests can
 * exercise the warning path deterministically.
 */
export function _resetProdOkWarningForTests(): void {
  warnedAboutProdOk = false;
}

/**
 * A key counts as prod-scoped when its `ref` / `name` / `vault_path` mentions
 * a typical prod marker. Conservative — false positives just nudge the user
 * to confirm; false negatives would defeat the gate.
 */
export function looksLikeProdKey(refOrName: string | undefined): boolean {
  if (!refOrName) return false;
  // Letter-boundary check: `\b` treats `_` as a word char (e.g. `PRD_DB`
  // wouldn't match `\bPRD\b`). Use explicit letter-not-letter boundaries
  // so `PRD_DB`, `stripe-live-key`, and `op://Prod/…` all trigger.
  return /(?<![A-Za-z])(prod|production|live|prd)(?![A-Za-z])/i.test(refOrName);
}
