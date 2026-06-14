/**
 * `kit secrets validate [--fix] [--auto]` — verify every key declared
 * in `.kit.toml [secrets.keys]` resolves to a non-empty value in the
 * configured vault. Surfaces drift between declaration and reality.
 *
 *   no flag  — read-only check; exits non-zero on missing values
 *   --fix    — interactive: prompt for value per missing key, write to vault
 *   --auto   — non-interactive: read from .env.template (key=value) when
 *              present, fail otherwise
 *
 * Read-only mode refuses --fix / --auto via the writeSecretToBackend gate.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { kitConfig, SecretKeyConfig } from "./config.js";
import { writeSecretToBackend, isValidKeyName } from "./secrets-migrate.js";

export interface ValidateResult {
  key: string;
  source: SecretKeyConfig["source"];
  status: "present" | "missing" | "fixed" | "unfixable";
  detail: string;
}

export interface ValidateOptions {
  fix?: boolean;
  auto?: boolean;
  /** Prompt callback for --fix interactive flow. Test injectable. */
  prompt?: (key: string) => Promise<string | null>;
  /** Test override of cwd. */
  cwd?: string;
}

async function loadEnvTemplate(cwd: string, templatePath: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const text = await readFile(resolve(cwd, templatePath), "utf-8");
    for (const rawLine of text.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (isValidKeyName(key)) out.set(key, value);
    }
  } catch {
    /* template missing — ok */
  }
  return out;
}

/**
 * Validate logic — checks for VALUE PRESENCE only. Uses an injectable
 * `checkAvailability` so tests can mock backend resolution without touching
 * real vaults.
 */
export async function validateSecrets(
  config: kitConfig,
  opts: ValidateOptions = {},
  checkAvailability: (key: string, source: SecretKeyConfig["source"], cfg: SecretKeyConfig) => Promise<boolean> = async (key, source, _cfg) => {
    if (source === "env") return Boolean(process.env[key]);
    // For all other sources we can't easily check without invoking the
    // backend CLI here — callers in CLI surface should pass the real
    // check function (see check-secrets.ts) so this default doesn't
    // false-positive in unit tests.
    return false;
  },
): Promise<ValidateResult[]> {
  const cwd = opts.cwd ?? process.cwd();
  const keys = config.secrets?.keys ?? {};
  const results: ValidateResult[] = [];
  const templateValues = config.secrets?.template
    ? await loadEnvTemplate(cwd, config.secrets.template)
    : new Map<string, string>();

  for (const [key, keyConfig] of Object.entries(keys)) {
    const present = await checkAvailability(key, keyConfig.source, keyConfig);
    if (present) {
      results.push({ key, source: keyConfig.source, status: "present", detail: "" });
      continue;
    }
    if (!opts.fix && !opts.auto) {
      results.push({
        key,
        source: keyConfig.source,
        status: "missing",
        detail: `not resolvable via ${keyConfig.source}`,
      });
      continue;
    }
    let value: string | null = null;
    if (opts.auto) {
      const candidate = templateValues.get(key);
      if (candidate && candidate.length > 0) {
        value = candidate;
      }
    } else if (opts.fix && opts.prompt) {
      value = await opts.prompt(key);
    }
    if (!value) {
      results.push({
        key,
        source: keyConfig.source,
        status: "unfixable",
        detail: opts.auto
          ? "no value in .env.template — re-run with --fix to enter interactively"
          : "no value provided",
      });
      continue;
    }
    const store = config.secrets?.store;
    if (!store || store === "env") {
      results.push({
        key,
        source: keyConfig.source,
        status: "unfixable",
        detail: "no vault backend configured ([secrets].store)",
      });
      continue;
    }
    const write = await writeSecretToBackend(store, key, value);
    results.push({
      key,
      source: keyConfig.source,
      status: write.ok ? "fixed" : "unfixable",
      detail: write.detail,
    });
  }

  return results;
}

export function summarizeValidation(results: ValidateResult[]): {
  total: number;
  present: number;
  missing: number;
  fixed: number;
  unfixable: number;
  ok: boolean;
} {
  const counts = { total: results.length, present: 0, missing: 0, fixed: 0, unfixable: 0, ok: true };
  for (const r of results) {
    counts[r.status]++;
  }
  counts.ok = counts.missing === 0 && counts.unfixable === 0;
  return counts;
}
