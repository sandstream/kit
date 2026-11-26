/**
 * `kit secrets list` — which keys kit sources from which backend. Names and metadata only.
 *
 * Before this module the only way to answer "which of my keys live in 1Password?" was a side effect
 * of `kit secrets vault-migrate --from 1password --dry-run` (kit-research#232, 1Password's
 * November 2026 incident). The inventory reads `.kit.toml` and kit's own audit log. It never
 * resolves a value: an inline `source = "config"` value is in the config object it reads, and no
 * field of {@link InventoryEntry} carries it.
 */
import type { kitConfig } from "./config.js";
import { BACKENDS } from "./secret-backends.js";
import { getEnvExpirationHint } from "./secret-expiration.js";
import { identifyProvider } from "./secrets-rotate-cli.js";
import { readSecretAuditEvents } from "./audit-secrets.js";
import { SECRET_WRITE_OPS } from "./secrets-write-record.js";

export type RotationKind = "from-cli" | "supabase-mgmt-api" | "manual";

export interface RotationHint {
  kind: RotationKind;
  /** The kit command a person runs for this key. Never run by kit on its own. */
  command: string;
}

export interface InventoryEntry {
  name: string;
  /** The backend the key resolves through (`[secrets.keys].<name>.source`). */
  source: string;
  /** `<KEY>_EXPIRES_AT` from the environment, as ISO, or null. */
  expiresAt: string | null;
  /** The last successful `secrets.rotate` kit recorded for this key, or null. */
  lastRotated: string | null;
  rotation: RotationHint;
}

/** Every backend kit can read from. The registry is the single source of truth. */
export function knownBackends(): string[] {
  return Object.keys(BACKENDS).sort();
}

export function isKnownBackend(name: string): boolean {
  return Object.hasOwn(BACKENDS, name);
}

const SUPABASE_MGMT_KEYS = /^SUPABASE_(SERVICE_ROLE|ANON|SECRET|PUBLISHABLE)_KEY$/;

/** The rotation path kit already ships for a key: a `--from-cli` playbook, the Supabase
 *  Management API path, or none ("manual"). It is printed, never executed. */
export function rotationHint(name: string): RotationHint {
  if (SUPABASE_MGMT_KEYS.test(name.toUpperCase())) {
    return {
      kind: "supabase-mgmt-api",
      command: `kit secrets rotate ${name} --via supabase-mgmt-api --project <ref>`,
    };
  }
  if (identifyProvider(name) !== "unknown") {
    return { kind: "from-cli", command: `kit secrets rotate ${name} --from-cli` };
  }
  return {
    kind: "manual",
    command: `manual: mint a new value at the provider, then kit secrets rotate ${name} --value <new>`,
  };
}

/** Latest successful rotation per key name, from `.kit-audit.jsonl`. Empty when there is no log. */
export async function lastRotations(cwd: string): Promise<Map<string, string>> {
  const events = await readSecretAuditEvents(cwd, 3650);
  const out = new Map<string, string>();
  for (const e of events) {
    if (e.operation !== SECRET_WRITE_OPS.rotate || !e.success) continue;
    const meta = (e.metadata ?? {}) as Record<string, unknown>;
    const names = [
      ...(typeof meta.name === "string" ? [meta.name] : []),
      ...(Array.isArray(meta.names) ? meta.names.filter((n) => typeof n === "string") : []),
    ] as string[];
    for (const n of names) {
      const prev = out.get(n);
      if (!prev || prev < e.timestamp) out.set(n, e.timestamp);
    }
  }
  return out;
}

/** Inventory of declared keys, optionally narrowed to one backend, sorted by name. Pure. */
export function buildInventory(
  config: kitConfig,
  opts: { backend?: string; rotations?: Map<string, string> } = {},
): InventoryEntry[] {
  const keys = config.secrets?.keys ?? {};
  const entries: InventoryEntry[] = [];
  for (const [name, cfg] of Object.entries(keys)) {
    if (opts.backend && cfg.source !== opts.backend) continue;
    entries.push({
      name,
      source: cfg.source,
      expiresAt: getEnvExpirationHint(name),
      lastRotated: opts.rotations?.get(name) ?? null,
      rotation: rotationHint(name),
    });
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}
