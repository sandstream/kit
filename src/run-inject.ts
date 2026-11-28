/**
 * `kit run --inject`: resolve the keys `.kit.toml` declares in `[secrets.keys]` and hand them to one
 * child through its environment. No `.env.local` is written, and none is read: a value kit cannot
 * resolve stops the run instead of falling back to a stale file (fail closed).
 *
 * Each run records `secrets.read` with `via: "kit run"` before any value is fetched
 * (`src/secrets-read-record.ts`), and the values are redacted from the child's output because they
 * sit in the child's environment under declared names (`declaredSecretValues` in `src/run.ts`).
 *
 * The 7.x default is unchanged; 8.0 makes injection the default
 * (docs/plans/2026-11-27-secrets-exec-inject.md).
 */
import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig, type SecretKeyConfig } from "./config.js";
import { getActiveEnv, looksLikeProdKey, prodReadAllowed } from "./env-switch.js";
import { resolveSecretsInMemory } from "./secrets.js";
import { readBy } from "./secrets-read-record.js";

// A named constant keeps `--inject` off the scanned flag surface of `kit clone`, which shares
// `cmdRun`'s module; `kit run` declares it in contracts/command-flags.json.
const INJECT_FLAG = "--inject";

/** True when kit's own arguments (those before `--`) ask for injection. Pure. */
export function injectRequested(kitArgs: readonly string[]): boolean {
  return kitArgs.includes(INJECT_FLAG);
}

/**
 * Merge resolved values over an inherited environment. Windows env names are case-insensitive, so
 * there an inherited `Path` is dropped before `PATH` is set; otherwise the child would get both,
 * and which one wins would depend on the order Windows reads them. Pure.
 */
export function mergeInjected(
  base: Record<string, string>,
  injected: ReadonlyMap<string, string>,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const env = { ...base };
  for (const [name, value] of injected) {
    if (platform === "win32") {
      const folded = name.toUpperCase();
      for (const existing of Object.keys(env)) {
        if (existing !== name && existing.toUpperCase() === folded) delete env[existing];
      }
    }
    env[name] = value;
  }
  return env;
}

function refuse(detail: string): never {
  throw new Error(`kit run --inject: ${detail}; the command was not started (fail-closed).`);
}

/** The same prod-scope rule `kit secrets` applies, so `--inject` is no way around it. */
async function assertProdReadAllowed(
  keys: Record<string, SecretKeyConfig>,
  cwd: string,
): Promise<void> {
  const prod = Object.entries(keys)
    .filter(([, k]) => [k.ref, k.name, k.vault_path].some((ref) => looksLikeProdKey(ref)))
    .map(([name]) => name);
  if (prod.length === 0) return;
  const activeEnv = await getActiveEnv(cwd);
  if (!prodReadAllowed(activeEnv, { cwd })) {
    refuse(
      `${prod.length} prod-scoped key(s) (${prod.join(", ")}) while the active env is "${activeEnv}"; run \`kit env switch prod\`, or set KIT_PROD_OK=1 in CI`,
    );
  }
}

/**
 * Resolve `cwd`'s declared secrets into memory, recorded as read by `kit run`. Throws, before the
 * child exists, when there is no `[secrets.keys]`, a key is prod-scoped outside prod, the read
 * cannot be recorded, or any key does not resolve. Error messages carry key names, never values.
 */
export async function resolveInjectedSecrets(cwd: string): Promise<Map<string, string>> {
  const path = resolve(cwd, ".kit.toml");
  try {
    await lstat(path);
  } catch {
    refuse(`no .kit.toml in ${cwd} declares [secrets.keys]`);
  }
  const config = await loadConfig(path);
  const keys = config.secrets?.keys ?? {};
  if (Object.keys(keys).length === 0) refuse(".kit.toml declares no [secrets.keys]");
  await assertProdReadAllowed(keys, cwd);
  const { results, resolved } = await resolveSecretsInMemory(config.secrets!, {
    ...readBy("kit run", config),
    cwd,
  });
  const missing = results.filter((r) => !r.resolved).map((r) => `${r.name} (${r.detail})`);
  if (missing.length > 0) refuse(`could not resolve ${missing.join(", ")}`);
  return resolved;
}
