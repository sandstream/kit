import { randomBytes } from "node:crypto";
import type { SecretsConfig } from "./config.js";

/**
 * Generates a cryptographically random opaque token suitable for rotating
 * services that accept arbitrary high-entropy secrets (signing keys, HMAC
 * shared-secrets, generic API tokens). Returns base64url so the value is
 * safe to embed in headers, env vars, and shell-pipe inputs.
 *
 * For services with a native rotation API (Stripe `roll-keys`, AWS IAM
 * `create-access-key`, GCP service-account-key-create), prefer the
 * service-specific flow in PR R3 — that's the only way to get a key the
 * service will recognize. This helper is only for opaque secrets.
 */
export function generateRandomToken(byteLength = 32): string {
  return randomBytes(byteLength).toString("base64url");
}

export interface RotationPlan {
  key: string;
  store: SecretsConfig["store"];
  source: "explicit" | "random";
  newValueLength: number;
  /** Refs the user should also update outside kit (deploy platforms) */
  externalTargets: string[];
}

/**
 * Builds a rotation plan from a key name + the user's CLI flags.
 *
 * - `--value <v>`     explicit new value
 * - `--random [N]`    generate a fresh base64url token (N bytes, default 32)
 *
 * Per-service rotation (Stripe / AWS IAM / GCP IAM) is deferred to PR R3.
 */
export function planRotation(
  key: string,
  config: SecretsConfig,
  flags: { value?: string; random?: number | true },
): { plan: RotationPlan; value: string } | { error: string } {
  if (!config.keys || !config.keys[key]) {
    return { error: `Key "${key}" not found in [secrets.keys]` };
  }

  let value: string;
  let source: RotationPlan["source"];
  if (typeof flags.value === "string" && flags.value.length > 0) {
    value = flags.value;
    source = "explicit";
  } else if (flags.random !== undefined) {
    const bytes = typeof flags.random === "number" ? flags.random : 32;
    if (bytes < 16 || bytes > 256) {
      return { error: `--random <N> must be between 16 and 256 bytes` };
    }
    value = generateRandomToken(bytes);
    source = "random";
  } else {
    return {
      error:
        "Provide --value <new> (explicit) or --random [N] (generate fresh). Per-service rotation (Stripe/AWS IAM/GCP) coming in PR R3.",
    };
  }

  // External-target hints — surface where else the user has to update the
  // key after the vault write. We don't push these in MVP; that's PR R2.
  const externalTargets: string[] = [];
  // Heuristic: common platforms users tend to configure.
  // We can't introspect them here (no .kit-targets.json yet), so list
  // the ones any deploy pipeline commonly touches.
  externalTargets.push(
    "Vercel project env (per environment)",
    "GitHub repo secrets",
    "CI provider env vars",
  );

  return {
    plan: {
      key,
      store: config.store,
      source,
      newValueLength: value.length,
      externalTargets,
    },
    value,
  };
}
