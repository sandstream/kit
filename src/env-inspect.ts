import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { kitConfig } from "./config.js";

export interface EnvKeyStatus {
  name: string;
  set: boolean;
  value?: string;
  redacted?: string;
  source: string;
}

export interface EnvInspectResult {
  ok: boolean;
  keys: EnvKeyStatus[];
  envLocalExists: boolean;
}

export interface InspectOptions {
  showValues?: boolean;
  missingOnly?: boolean;
  cwd?: string;
}

/**
 * Parse a .env file into a key-value record.
 * Handles blank lines, comments (#), and quoted values.
 */
export function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;

    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1);

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    result[key] = value;
  }

  return result;
}

/**
 * Redact a secret value: show first 4 chars + ****
 */
export function redactValue(value: string): string {
  if (value.length <= 4) return "****";
  return value.slice(0, 4) + "****";
}

export async function inspectEnv(
  config: kitConfig,
  options: InspectOptions = {},
): Promise<EnvInspectResult> {
  const cwd = options.cwd ?? process.cwd();
  const envPath = join(cwd, ".env.local");

  let envVars: Record<string, string> = {};
  let envLocalExists = false;

  try {
    const content = await readFile(envPath, "utf-8");
    envVars = parseEnvFile(content);
    envLocalExists = true;
  } catch {
    // .env.local doesn't exist or is unreadable
  }

  // Collect key names from config and from .env.local
  const keyNames = new Set<string>();
  const keySource: Record<string, string> = {};

  if (config.secrets?.keys) {
    for (const [name, cfg] of Object.entries(config.secrets.keys)) {
      keyNames.add(name);
      keySource[name] = cfg.source;
    }
  }

  for (const name of Object.keys(envVars)) {
    if (!keyNames.has(name)) {
      keyNames.add(name);
      keySource[name] = ".env.local";
    }
  }

  const allKeys = [...keyNames].sort();

  const keys: EnvKeyStatus[] = allKeys.map((name) => {
    const rawValue = envVars[name];
    const set = rawValue !== undefined;
    const entry: EnvKeyStatus = { name, set, source: keySource[name] ?? ".env.local" };

    if (set) {
      if (options.showValues) {
        entry.value = rawValue;
      } else {
        entry.redacted = redactValue(rawValue);
      }
    }

    return entry;
  });

  const filteredKeys = options.missingOnly ? keys.filter((k) => !k.set) : keys;
  const ok = keys.every((k) => k.set);

  return { ok, keys: filteredKeys, envLocalExists };
}
