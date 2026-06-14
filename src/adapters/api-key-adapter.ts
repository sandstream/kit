import type { ServiceAdapter, AdapterContext, ProvisionResult } from "./types.js";

/**
 * Factory for the common "API-key only" service adapter.
 *
 * Many services have no programmatic account/key creation — provisioning is
 * just "do the required keys exist in the environment?". Those adapters were
 * ~50 lines of identical check/provision boilerplate differing only in key
 * names, an optional value-with-default, an optional key-prefix sanity check,
 * and the dashboard steps. This collapses each to a small spec. Adapters with
 * genuinely bespoke logic (CLI provisioning, key derivation) stay hand-written.
 */

interface RequiredKey {
  env: string;
  /** Optional sanity prefix — the key must start with this to count as present. */
  prefix?: string;
}

interface OptionalKey {
  env: string;
  /** If set, this value is written when the key is absent. If omitted, the key
   *  is pass-through: included in secrets only when already present. */
  default?: string;
}

export interface ApiKeyAdapterSpec {
  name: string;
  description: string;
  /** Keys that must all be present for the service to count as configured. */
  required: (string | RequiredKey)[];
  /** Extra keys carried into the generated secrets (defaults / pass-through). */
  optional?: OptionalKey[];
  /** "How to get the key(s)" lines shown when required keys are missing. Must
   *  mention the dashboard URL and key names — that's the actionable part. */
  steps: string[];
}

function normalize(key: string | RequiredKey): RequiredKey {
  return typeof key === "string" ? { env: key } : key;
}

function isPresent(env: Record<string, string>, key: RequiredKey): boolean {
  const value = env[key.env];
  return !!value && (!key.prefix || value.startsWith(key.prefix));
}

export function apiKeyAdapter(spec: ApiKeyAdapterSpec): ServiceAdapter {
  const required = spec.required.map(normalize);

  return {
    name: spec.name,
    description: spec.description,

    getRequiredTools(): string[] {
      return []; // API-based, no CLI needed
    },

    async check(context: AdapterContext): Promise<boolean> {
      return required.every((k) => isPresent(context.existingEnv, k));
    },

    async provision(context: AdapterContext): Promise<ProvisionResult> {
      const env = context.existingEnv;

      if (required.every((k) => isPresent(env, k))) {
        const secrets: Record<string, string> = {};
        for (const k of required) secrets[k.env] = env[k.env];
        for (const o of spec.optional ?? []) {
          if (env[o.env] !== undefined) secrets[o.env] = env[o.env];
          else if (o.default !== undefined) secrets[o.env] = o.default;
        }
        return {
          success: true,
          message: `${spec.name} already configured — keys present in environment`,
          secrets,
          config: { service: spec.name, existing: true },
        };
      }

      const absent = required.filter((k) => !isPresent(env, k)).map((k) => k.env);
      const error =
        required.length === 1
          ? `Missing ${required[0].env}`
          : `Missing ${spec.name} credentials: ${absent.join(", ")}`;
      return { success: false, error, message: spec.steps.join("\n") };
    },
  };
}
