/**
 * Cross-vault secret migration.
 *
 * `kit secrets migrate` covers plaintext-→-vault. This module covers the
 * harder case: moving every key defined in `.kit.toml` from one configured
 * backend to another (e.g. 1password → infisical) without ever printing the
 * value to a console and without leaving a half-migrated state on failure.
 *
 * Flow per key:
 *   1. Read value from source backend (no log echo).
 *   2. Write value to target backend.
 *   3. Rewrite the `.kit.toml` entry in place — `source = "target"`,
 *      `ref`/`name` updated to the new backend's convention.
 *   4. Audit-log the move (operation: "vault-migrate", success: bool).
 *
 * Errors at step 2 leave step 3 untouched — the source vault remains the
 * authoritative store. The user is told which keys succeeded so they can
 * re-run for the rest.
 *
 * NOT included by design:
 *   - Deleting the value from the source vault. That's a separate
 *     `kit secrets revoke-old` call (already exists). Keeping the old
 *     copy until rotation lets the operator roll back if the target is
 *     misconfigured.
 *   - Rotation. Migration moves the SAME value. Use `secrets rotate` after
 *     migration if you also want to mint fresh credentials.
 */

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { SecretsConfig, SecretKeyConfig } from "./config.js";
import { writeSecretToBackend, isValidKeyName, escapeRegex } from "./secrets-migrate.js";
import { redactSecrets } from "./utils/redactSecrets.js";
import { appendAuditEventDirect } from "./audit.js";
import { exec } from "./utils/exec.js";


type BackendSource = SecretKeyConfig["source"];

export interface VaultMigrateOptions {
  /** Source backend currently referenced in `.kit.toml`. */
  from: BackendSource;
  /** Target backend to migrate to. */
  to: BackendSource;
  /** Show what would happen without writing anywhere. */
  dryRun?: boolean;
  /** cwd override (for tests). */
  cwd?: string;
}

export interface MigrationItem {
  name: string;
  ok: boolean;
  detail: string;
  /** New ref written to .kit.toml on success. */
  newRef?: string;
}

export interface VaultMigrateResult {
  items: MigrationItem[];
  /** Source keys discovered. */
  discovered: number;
  /** Number of items that completed all three steps. */
  succeeded: number;
}

/**
 * Reads a single secret value from the configured source backend. Returns
 * `{ ok: false }` and never the value when reading fails, so the caller
 * cannot accidentally write an empty string to the target.
 */
export async function readSecretFromBackend(
  source: BackendSource,
  config: SecretKeyConfig,
  topLevel: SecretsConfig,
): Promise<{ ok: boolean; value?: string; detail: string }> {
  try {
    switch (source) {
      case "1password": {
        if (!config.ref) return { ok: false, detail: "no 1Password ref" };
        // Pre-flight: refuse to call `op read` without an account configured.
        // Otherwise op prompts "Do you want to add an account?" on every call
        // and the migration emits 12 vague "Command failed" lines per key.
        const { check1PasswordStatus } = await import("./onepassword.js");
        const opStatus = await check1PasswordStatus();
        if (!opStatus.installed) {
          return { ok: false, detail: "1Password CLI not installed" };
        }
        if (!opStatus.authenticated) {
          return {
            ok: false,
            detail:
              "1Password CLI present but no account configured — run 'op account add', enable desktop-app CLI integration, or set OP_SERVICE_ACCOUNT_TOKEN",
          };
        }
        const { stdout } = await exec("op", ["read", config.ref, "--no-newline"], {
          timeout: 15_000,
        });
        return { ok: true, value: stdout, detail: "read from 1Password" };
      }
      case "infisical": {
        const name = config.name;
        if (!name) return { ok: false, detail: "no Infisical name" };
        const args = ["secrets", "get", name, "--plain"];
        if (topLevel.infisical?.project_id) args.push("--projectId", topLevel.infisical.project_id);
        if (topLevel.infisical?.environment) args.push("--env", topLevel.infisical.environment);
        const { stdout } = await exec("infisical", args, { timeout: 15_000 });
        return { ok: true, value: stdout.trim(), detail: "read from Infisical" };
      }
      case "bitwarden": {
        const field = config.name || config.ref;
        if (!field) return { ok: false, detail: "no Bitwarden field" };
        const { stdout } = await exec("bw", ["get", field], { timeout: 15_000 });
        return { ok: true, value: stdout.trim(), detail: "read from Bitwarden" };
      }
      case "doppler": {
        if (!config.name) return { ok: false, detail: "no Doppler name" };
        const { stdout } = await exec(
          "doppler",
          ["secrets", "get", config.name, "--plain"],
          { timeout: 15_000 },
        );
        return { ok: true, value: stdout.trim(), detail: "read from Doppler" };
      }
      case "vault": {
        const path = config.vault_path || "secret/data/kit";
        const field = config.name || "value";
        const { stdout } = await exec(
          "vault",
          ["kv", "get", "-field", field, path],
          { timeout: 15_000 },
        );
        return { ok: true, value: stdout.trim(), detail: `read from Vault ${path}` };
      }
      case "aws-sm": {
        const args = ["secretsmanager", "get-secret-value", "--secret-id", config.name || ""];
        if (config.aws_region) args.push("--region", config.aws_region);
        args.push("--query", "SecretString", "--output", "text");
        const { stdout } = await exec("aws", args, { timeout: 15_000 });
        return { ok: true, value: stdout.trim(), detail: "read from AWS Secrets Manager" };
      }
      case "gcp-sm": {
        const args = ["secrets", "versions", "access", "latest", "--secret", config.name || ""];
        if (config.gcp_project) args.push("--project", config.gcp_project);
        const { stdout } = await exec("gcloud", args, { timeout: 15_000 });
        return { ok: true, value: stdout.trim(), detail: "read from GCP Secret Manager" };
      }
      case "azure-kv": {
        const vault = config.azure_vault;
        if (!vault) return { ok: false, detail: "no Azure vault" };
        const { stdout } = await exec(
          "az",
          ["keyvault", "secret", "show", "--vault-name", vault, "--name", config.name || "", "--query", "value", "-o", "tsv"],
          { timeout: 15_000 },
        );
        return { ok: true, value: stdout.trim(), detail: "read from Azure Key Vault" };
      }
      case "env":
      case "config":
        return {
          ok: false,
          detail: `source "${source}" is plaintext-resident — use 'kit secrets migrate' (env/.env → vault) instead`,
        };
      default:
        return { ok: false, detail: `read from "${source}" not supported` };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
    return { ok: false, detail: `read failed: ${redactSecrets(msg)}` };
  }
}

/**
 * Rewrites `.kit.toml` in place so the named key's `source` / `ref` /
 * `name` reflect the new backend. Conservative regex-based edit — we only
 * touch lines that match the `<KEY> = { source = "<from>", ...` shape so
 * unrelated TOML structure is preserved exactly as the user wrote it.
 */
async function rewriteConfigRef(
  cwd: string,
  keyName: string,
  to: BackendSource,
  newRef: string,
): Promise<{ ok: boolean; detail: string }> {
  if (!isValidKeyName(keyName)) {
    return { ok: false, detail: `invalid key name "${keyName}"` };
  }
  const path = resolve(cwd, ".kit.toml");
  let text: string;
  try {
    text = await readFile(path, "utf-8");
  } catch {
    return { ok: false, detail: ".kit.toml not readable" };
  }
  // Match the whole inline-table line for this key. keyName is already
  // validated by isValidKeyName above; escapeRegex is defense-in-depth.
  const lineRe = new RegExp(`^(\\s*${escapeRegex(keyName)}\\s*=\\s*\\{)[^}\\n]*(\\}\\s*)$`, "m");
  const match = text.match(lineRe);
  if (!match) {
    return { ok: false, detail: `key "${keyName}" not found in .kit.toml or shape unexpected` };
  }
  // Pick the right inline-table key for the target backend.
  const inline =
    to === "1password"
      ? `source = "1password", ref = "${newRef}"`
      : to === "vault"
        ? `source = "vault", vault_path = "${newRef}"`
        : `source = "${to}", name = "${newRef}"`;
  const replaced = text.replace(lineRe, `$1 ${inline} $2`);
  if (replaced === text) {
    return { ok: false, detail: `no change written for "${keyName}"` };
  }
  await writeFile(path, replaced, "utf-8");
  return { ok: true, detail: "rewrote .kit.toml" };
}

/**
 * Orchestrates the migration. Caller is responsible for elevation (call
 * `consumeElevation("vault-migrate")` first) so we don't double-prompt.
 */
export async function vaultMigrate(
  config: { secrets?: SecretsConfig },
  opts: VaultMigrateOptions,
): Promise<VaultMigrateResult> {
  const items: MigrationItem[] = [];
  const cwd = opts.cwd ?? process.cwd();
  const entries = Object.entries(config.secrets?.keys ?? {});
  const targeted = entries.filter(([, c]) => c.source === opts.from);

  for (const [name, keyConfig] of targeted) {
    const read = await readSecretFromBackend(
      opts.from,
      keyConfig,
      config.secrets ?? ({} as SecretsConfig),
    );
    if (!read.ok || !read.value) {
      items.push({ name, ok: false, detail: `read: ${read.detail}` });
      await appendAuditEventDirect({
        operation: "vault-migrate",
        environment: process.env.KIT_ENV ?? "unknown",
        success: false,
        error: read.detail,
        metadata: { key: name, from: opts.from, to: opts.to, stage: "read" },
      }, { cwd });
      continue;
    }

    if (opts.dryRun) {
      items.push({
        name,
        ok: true,
        detail: `would migrate to ${opts.to} (dry-run, ${read.value.length} chars)`,
      });
      continue;
    }

    // writeSecretToBackend's `store` parameter is narrower than BackendSource
    // (excludes "config" / "eas" — neither makes sense as a write target).
    // The reader returned !ok above for those cases, so this assertion is safe.
    const writeStore = opts.to as Exclude<BackendSource, "config" | "eas">;
    const write = await writeSecretToBackend(writeStore, name, read.value, {
      vault: keyConfig.azure_vault,
      project: keyConfig.gcp_project,
      region: keyConfig.aws_region,
      vaultPath: keyConfig.vault_path,
    });
    if (!write.ok) {
      items.push({ name, ok: false, detail: `write: ${write.detail}` });
      await appendAuditEventDirect({
        operation: "vault-migrate",
        environment: process.env.KIT_ENV ?? "unknown",
        success: false,
        error: write.detail,
        metadata: { key: name, from: opts.from, to: opts.to, stage: "write" },
      }, { cwd });
      continue;
    }

    // Determine the new ref the target backend uses. 1password gives us
    // `op://...`; others store under name = "<KEY>" or vault-path.
    const newRef =
      write.ref ??
      (opts.to === "vault"
        ? keyConfig.vault_path || `secret/data/kit#${name}`
        : name);
    const rewrite = await rewriteConfigRef(cwd, name, opts.to, newRef);
    if (!rewrite.ok) {
      items.push({
        name,
        ok: false,
        detail: `write OK but config rewrite failed: ${rewrite.detail}`,
        newRef,
      });
      await appendAuditEventDirect({
        operation: "vault-migrate",
        environment: process.env.KIT_ENV ?? "unknown",
        success: false,
        error: rewrite.detail,
        metadata: { key: name, from: opts.from, to: opts.to, stage: "rewrite", newRef },
      }, { cwd });
      continue;
    }

    items.push({ name, ok: true, detail: `migrated to ${opts.to}`, newRef });
    await appendAuditEventDirect({
      operation: "vault-migrate",
      environment: process.env.KIT_ENV ?? "unknown",
      success: true,
      metadata: { key: name, from: opts.from, to: opts.to, newRef },
    }, { cwd });
  }

  return {
    items,
    discovered: targeted.length,
    succeeded: items.filter((i) => i.ok).length,
  };
}
