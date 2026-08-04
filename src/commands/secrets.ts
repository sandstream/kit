/**
 * `kit secrets` command cluster — extracted from cli.ts (5.0-alpha god-module split).
 *
 * `cmdSecrets` is the single top-level entry (registered in the COMMANDS dispatch
 * table in cli.ts); it routes `kit secrets <sub>` to the module-private handlers
 * below via process.argv[3]. Subcommands: validate, onecli, revoke-old, set,
 * propagate, purge-history, migrate, vault-migrate, sync, rotate.
 *
 * `ensureSecretsBackend` intentionally stays in cli.ts (cmdLogin uses it).
 * Mirrors the scan.ts/security.ts extraction pattern: imports only sibling core
 * modules, never cli.ts.
 */
import { createInterface } from "node:readline/promises";
import { c } from "../utils/colors.js";
import { hasFlag, flagValue } from "../utils/flags.js";
import { loadConfig, type kitConfig, type SecretKeyConfig } from "../config.js";
import { KIT_FILE, resolveConfigPath } from "../cli-shared.js";
import { isNonInteractive } from "../environment.js";
import { promptConfirm } from "../utils/prompt.js";
import { validateSecrets, summarizeValidation } from "../secrets-validate.js";
import {
  planMigration,
  writeSecretToBackend,
  commentOutInFile,
  type PostMigrateMode,
} from "../secrets-migrate.js";
import { cmdSecretsRotate, pickBackendOpts } from "../secrets-rotate-cli.js";
import { setSecretValue, type SetValueOptions } from "../secrets-set.js";
import {
  detectTools as detectPurgeTools,
  previewMatches,
  purgeHistory,
} from "../secrets-purge-history.js";
import {
  propagate,
  parseTargets,
  ALL_TARGETS,
  type PropagationOptions,
} from "../secrets-propagate.js";
import { requireElevation, consumeElevation } from "../elevation.js";
import {
  checkOneCliStatus,
  registerSecretInOneCli,
  generatePlaceholder,
  resolveOneCliConfig,
} from "../secrets-onecli.js";
import { generateSecrets } from "../secrets.js";
import { syncSecrets } from "../secrets-sync.js";
import { withGovernance } from "../governance-middleware.js";
import { vaultMeta } from "../vault-meta.js";
import { vaultCliInstalled, resolveViaBackend } from "../secret-backends.js";

/**
 * `kit secrets validate [--fix] [--auto]` — verify every declared key resolves
 * to a non-empty value in the configured backend. Read-only by default; exits
 * non-zero when keys are missing/unfixable. `--fix` prompts interactively,
 * `--auto` pulls from .env.template. Writes go through the gated backend writer.
 */
async function cmdSecretsValidate(): Promise<boolean> {
  const config = await loadConfig(resolveConfigPath());
  if (!config.secrets) {
    console.log(`${c.dim}No secrets configured in ${KIT_FILE}${c.reset}`);
    return true;
  }
  const fix = hasFlag(process.argv, "--fix");
  const auto = hasFlag(process.argv, "--auto");

  // Real availability check: env vars locally, everything else via its backend.
  const checkAvailability = async (
    key: string,
    source: SecretKeyConfig["source"],
    cfg: SecretKeyConfig,
  ): Promise<boolean> => {
    if (source === "env") return Boolean(process.env[key]);
    if (source === "config") return Boolean(cfg.value);
    const r = await resolveViaBackend(key, cfg, config.secrets?.infisical);
    return r.resolved && Boolean(r.value);
  };

  const rl = fix ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  const prompt = rl
    ? async (key: string): Promise<string | null> => {
        const answer = (
          await rl.question(`  ${c.cyan}${key}${c.reset} value (blank to skip): `)
        ).trim();
        return answer.length > 0 ? answer : null;
      }
    : undefined;

  console.log(`${c.bold}${c.cyan}kit secrets validate${c.reset}`);
  try {
    const results = await validateSecrets(config, { fix, auto, prompt }, checkAvailability);
    for (const r of results) {
      const icon =
        r.status === "present" || r.status === "fixed"
          ? `${c.green}✓${c.reset}`
          : r.status === "missing"
            ? `${c.red}✗${c.reset}`
            : `${c.yellow}⚠${c.reset}`;
      console.log(
        `  ${icon} ${r.key} ${c.dim}(${r.source})${c.reset}${r.detail ? ` — ${r.detail}` : ""}`,
      );
    }
    const s = summarizeValidation(results);
    const tail = [
      s.missing ? `${s.missing} missing` : "",
      s.unfixable ? `${s.unfixable} unfixable` : "",
      s.fixed ? `${s.fixed} fixed` : "",
    ]
      .filter(Boolean)
      .join(", ");
    console.log(
      `\n${s.ok ? c.green : c.red}${s.present + s.fixed}/${s.total} resolvable${c.reset}${tail ? ` ${c.dim}(${tail})${c.reset}` : ""}`,
    );
    return s.ok;
  } finally {
    rl?.close();
  }
}

export async function cmdSecrets(): Promise<boolean> {
  // Route subcommand: kit secrets sync [--target=...] [--dry-run]
  if (process.argv[3] === "sync") {
    return cmdSecretsSync();
  }
  if (process.argv[3] === "validate") {
    return cmdSecretsValidate();
  }
  if (process.argv[3] === "migrate") {
    return cmdSecretsMigrate();
  }
  if (process.argv[3] === "vault-migrate") {
    return cmdSecretsVaultMigrate();
  }
  if (process.argv[3] === "rotate") {
    return cmdSecretsRotate();
  }
  if (process.argv[3] === "onecli") {
    return cmdSecretsOneCli();
  }
  if (process.argv[3] === "purge-history") {
    return cmdSecretsPurgeHistory();
  }
  if (process.argv[3] === "propagate") {
    return cmdSecretsPropagateStandalone();
  }
  if (process.argv[3] === "set") {
    return cmdSecretsSet();
  }
  if (process.argv[3] === "revoke-old") {
    return cmdSecretsRevokeOld();
  }

  const config = await loadConfig(resolveConfigPath());

  if (!config.secrets) {
    console.log(`${c.dim}No secrets configured in ${KIT_FILE}${c.reset}`);
    return true;
  }

  const secretsConfig = config.secrets;

  // ── S9: refuse prod-scoped keys outside prod env ──────────────────────────
  // Each key's source/ref/vault_path is checked against a "prod" marker;
  // if any prod-scoped key is configured AND the active env is not "prod",
  // require explicit KIT_PROD_OK=1 to proceed (CI deploy jobs set this).
  const { looksLikeProdKey, getActiveEnv, prodReadAllowed } = await import("../env-switch.js");
  const activeEnv = await getActiveEnv(process.cwd());
  const prodKeys = Object.entries(secretsConfig.keys ?? {}).filter(([, v]) => {
    return looksLikeProdKey(v.ref) || looksLikeProdKey(v.name) || looksLikeProdKey(v.vault_path);
  });
  if (prodKeys.length > 0 && !prodReadAllowed(activeEnv)) {
    console.error(
      `${c.red}✗ Refusing to materialize ${prodKeys.length} prod-scoped key(s) — active env is "${activeEnv}".${c.reset}`,
    );
    for (const [name, v] of prodKeys.slice(0, 5)) {
      const ref = v.ref ?? v.name ?? v.vault_path ?? "?";
      console.error(`  ${c.dim}•${c.reset} ${name}  ${c.dim}${ref}${c.reset}`);
    }
    if (prodKeys.length > 5) {
      console.error(`  ${c.dim}… and ${prodKeys.length - 5} more${c.reset}`);
    }
    console.error(
      `\n${c.dim}To proceed: ${c.bold}kit env switch prod${c.reset}${c.dim} (interactive), or set ${c.bold}KIT_PROD_OK=1${c.reset}${c.dim} in CI.${c.reset}\n`,
    );
    return false;
  }

  console.log(
    `${c.bold}${c.cyan}Generating secrets...${c.reset}  ${c.dim}(env=${activeEnv})${c.reset}\n`,
  );

  return await withGovernance(
    config,
    {
      operation: "secrets.generate",
      operationType: "write",
      metadata: {
        store: secretsConfig.store,
        template: secretsConfig.template,
      },
      // Declared effects (scope-needs adoption): kit's OWN direct effect is the
      // .env.local write plus materializing the named keys — both statically
      // known here. The vault CLI resolves values in ITS OWN subprocess, whose
      // network I/O is the CLI's, not kit's — so egress is not kit's to claim
      // (same reasoning as the MCP kit_secrets site). Under a signed [scope]
      // these needs must be inside the RoE; without one, behavior is unchanged.
      scopeNeeds: {
        fsWrites: [".env.local"],
        secrets: Object.keys(secretsConfig.keys ?? {}),
      },
    },
    async () => {
      const { results, written, fromTemplate, skipped } = await generateSecrets(secretsConfig);
      let allOk = true;

      for (const r of results) {
        const icon = r.resolved ? `${c.green}✓${c.reset}` : `${c.red}✗${c.reset}`;
        const status = r.resolved ? `${c.green}resolved${c.reset}` : `${c.red}missing${c.reset}`;
        console.log(`  ${icon} ${r.name}  ${status}  ${c.dim}${r.detail}${c.reset}`);
        if (!r.resolved) allOk = false;
      }

      if (written) {
        const source = fromTemplate ? `from ${secretsConfig.template}` : "from keys";
        console.log(`\n  ${c.green}✓${c.reset} Wrote .env.local ${c.dim}(${source})${c.reset}`);
      } else if (skipped === "nothing-resolved") {
        console.log(
          `\n  ${c.yellow}!${c.reset} Skipped .env.local ${c.dim}— no secrets resolved (vault empty/unauthed); existing file left intact${c.reset}`,
        );
      }

      // Loud, actionable vault-readiness flag. A chosen vault that resolves zero
      // secrets is almost always "CLI installed but not logged in" — surface
      // that once, with the exact next command, instead of leaving the user to
      // infer it from a column of per-key ✗ lines.
      const meta = vaultMeta(secretsConfig.store);
      const resolvedCount = results.filter((r) => r.resolved).length;
      if (meta && results.length > 0 && resolvedCount === 0) {
        const installed = meta.miseTool ? await vaultCliInstalled(meta.miseTool) : true;
        console.log(
          `\n  ${c.yellow}${c.bold}! Vault "${secretsConfig.store}" is configured but resolved 0 secrets.${c.reset}`,
        );
        if (meta.miseTool && !installed) {
          console.log(
            `  ${c.dim}The ${meta.label} CLI isn't installed yet — run ${c.reset}${c.bold}kit setup${c.reset}${c.dim} (installs it via mise).${c.reset}`,
          );
        } else if (meta.loginCmd) {
          console.log(
            `  ${c.dim}The ${meta.label} CLI is installed but not authenticated. Log in:${c.reset}`,
          );
          console.log(`      ${c.bold}${meta.loginCmd}${c.reset}`);
          if (meta.initCmd) {
            console.log(
              `  ${c.dim}then bind this repo:${c.reset}  ${c.bold}${meta.initCmd}${c.reset}`,
            );
          }
          console.log(
            `  ${c.dim}then re-run ${c.reset}${c.bold}kit secrets${c.reset}${c.dim}.${c.reset}`,
          );
        }
      }

      console.log();
      return allOk;
    },
  );
}
async function cmdSecretsOneCli(): Promise<boolean> {
  // Sub-sub: kit secrets onecli [status|register <KEY> --host <pattern>]
  const sub = process.argv[4] ?? "status";

  if (sub === "status") {
    console.log(`${c.bold}${c.cyan}kit secrets onecli status${c.reset}`);
    console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);
    const status = await checkOneCliStatus();
    const reach = status.reachable
      ? `${c.green}reachable${c.reset}`
      : `${c.red}unreachable${c.reset}`;
    const auth = status.authenticated
      ? `${c.green}authenticated${c.reset}`
      : `${c.red}not authenticated${c.reset}`;
    console.log(`  Gateway API:    ${status.apiUrl}  ${reach}`);
    console.log(
      `  Gateway proxy:  ${status.gatewayUrl}  ${c.dim}(set HTTPS_PROXY here for agent processes)${c.reset}`,
    );
    console.log(`  Auth:           ${auth}`);
    if (status.version) {
      console.log(`  Version:        ${c.dim}${status.version}${c.reset}`);
    }
    if (status.error) {
      console.log(`  ${c.yellow}→${c.reset} ${status.error}`);
    }
    console.log();
    if (!status.reachable) {
      console.log(
        `${c.dim}Start OneCLI: ${c.bold}cd /path/to/onecli && docker compose -f docker/docker-compose.yml up -d${c.reset}${c.dim}, or set ${c.bold}ONECLI_API_URL${c.reset}${c.dim} if it runs elsewhere.${c.reset}\n`,
      );
    }
    return status.reachable && status.authenticated;
  }

  if (sub !== "register") {
    console.error(
      `${c.red}Usage: kit secrets onecli [status|register <KEY> --host <pattern> [--path <pattern>]]${c.reset}`,
    );
    return false;
  }

  const args = process.argv.slice(5);
  const keyName = args[0];
  if (!keyName || keyName.startsWith("--")) {
    console.error(
      `${c.red}Usage: kit secrets onecli register <KEY> --host <pattern> [--path <pattern>]${c.reset}`,
    );
    return false;
  }
  const hostPattern = flagValue(args, "--host");
  const pathPattern = flagValue(args, "--path");

  if (!hostPattern) {
    console.error(`${c.red}--host required (e.g. api.stripe.com, api.openai.com).${c.reset}`);
    return false;
  }

  console.log(`${c.bold}${c.cyan}kit secrets onecli register${c.reset}`);
  console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);

  // S12: gate destructive op behind explicit elevation.
  // Register writes a fake placeholder into .env.local; one elevation =
  // one register so a stale TTL can't re-overwrite the file.
  const elev = await consumeElevation("onecli-register");
  if (!elev.ok) {
    console.error(`${c.red}✗ ${elev.reason}${c.reset}`);
    return false;
  }

  // 1. Verify OneCLI is reachable + authed before reading the secret.
  const status = await checkOneCliStatus();
  if (!status.reachable || !status.authenticated) {
    console.error(`${c.red}OneCLI not ready: ${status.error ?? "unreachable"}${c.reset}`);
    console.error(
      `${c.dim}Run ${c.bold}kit secrets onecli status${c.reset}${c.dim} for details.${c.reset}`,
    );
    return false;
  }

  // 2. Read the real value from the configured upstream vault.
  const config = await loadConfig(resolveConfigPath());
  if (!config.secrets?.store || config.secrets.store === "env") {
    console.error(`${c.red}No upstream vault configured in .kit.toml.${c.reset}`);
    console.error(
      `${c.dim}Set ${c.bold}[secrets].store${c.reset}${c.dim} (run ${c.bold}kit init${c.reset}${c.dim}) first so kit knows where to read the real value from.${c.reset}`,
    );
    return false;
  }
  const keyConfig = config.secrets.keys?.[keyName];
  if (!keyConfig) {
    console.error(
      `${c.red}Key "${keyName}" not in [secrets.keys] — run ${c.bold}kit init${c.reset}${c.red} or add it manually.${c.reset}`,
    );
    return false;
  }

  const { generateSecrets: _unused } = await import("../secrets.js");
  void _unused;
  // resolveSecret isn't exported; reuse generateSecrets to pull the one value
  // we need. Cheaper: re-export resolveSecret, but for MVP we shell to op
  // /infisical/etc through the same code by asking generateSecrets to write
  // to a tmp file. Simpler: just use the env-resolution branch directly when
  // possible, and tell the user to use `kit secrets` for vault-resolution.
  // To avoid that complication for v1, require the value via stdin instead:
  console.log(
    `${c.dim}Reading real value from upstream vault (${config.secrets.store})...${c.reset}`,
  );
  const realValue = await readSecretValueFromVault(keyName, config);
  if (!realValue) {
    console.error(`${c.red}Could not resolve "${keyName}" from upstream vault.${c.reset}`);
    console.error(
      `${c.dim}Check auth with ${c.bold}kit check${c.reset}${c.dim} and retry.${c.reset}`,
    );
    return false;
  }

  // 3. Register with OneCLI.
  try {
    const result = await registerSecretInOneCli({
      name: keyName,
      value: realValue,
      hostPattern,
      pathPattern,
    });
    console.log(
      `  ${c.green}✓${c.reset} registered ${c.bold}${keyName}${c.reset} in OneCLI  ${c.dim}(id ${result.id.slice(0, 8)}…, host=${hostPattern})${c.reset}`,
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${c.red}OneCLI register failed: ${msg}${c.reset}`);
    return false;
  }

  // 4. Write placeholder to .env.local so agents read a non-credential.
  const placeholder = generatePlaceholder();
  const { writeFile, readFile, access } = await import("node:fs/promises");
  const envPath = `${process.cwd()}/.env.local`;
  let envContent: string;
  try {
    await access(envPath);
    envContent = await readFile(envPath, "utf-8");
  } catch {
    envContent = "";
  }
  const lineRe = new RegExp(`^${keyName}=.*$`, "m");
  const newLine = `${keyName}=${placeholder}  # placeholder — real value lives in OneCLI`;
  if (lineRe.test(envContent)) {
    envContent = envContent.replace(lineRe, newLine);
  } else {
    if (!envContent.endsWith("\n") && envContent.length > 0) envContent += "\n";
    envContent += newLine + "\n";
  }
  await writeFile(envPath, envContent, "utf-8");
  console.log(
    `  ${c.green}✓${c.reset} wrote placeholder to .env.local  ${c.dim}(${placeholder.slice(0, 14)}…)${c.reset}`,
  );

  // 5. Surface the proxy setup the agent needs to honor.
  const cfg = resolveOneCliConfig();
  console.log();
  console.log(`${c.bold}Next: route agent traffic through OneCLI${c.reset}`);
  console.log(
    `${c.dim}For the agent process to use the placeholder + get the real value injected, point its HTTPS proxy at:${c.reset}`,
  );
  console.log(`  ${c.bold}HTTPS_PROXY=${cfg.gatewayUrl}${c.reset}`);
  console.log(`  ${c.bold}HTTP_PROXY=${cfg.gatewayUrl}${c.reset}`);
  console.log(
    `${c.dim}OneCLI will intercept requests to ${c.bold}${hostPattern}${c.reset}${c.dim}, swap in the real value, and forward.${c.reset}\n`,
  );
  return true;
}

async function readSecretValueFromVault(
  keyName: string,
  config: kitConfig,
): Promise<string | null> {
  // Reuse generateSecrets() to materialize values, then read the one we want.
  // Writes to a temp file then deletes it; the real value never touches the
  // working tree.
  if (!config.secrets) return null;
  const { generateSecrets } = await import("../secrets.js");
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { secureDir, secureFile } = await import("../utils/secure-perms.js");
  const dir = mkdtempSync(join(tmpdir(), "kit-onecli-"));
  secureDir(dir); // mkdtemp is 0o777-masked; the .env below holds a materialized secret
  const tmpEnv = join(dir, ".env");
  try {
    // We need generateSecrets to write to a path of our choosing; the current
    // signature takes outputPath. Use a no-template config so values land
    // verbatim as KEY=VALUE lines.
    const isolated = {
      ...config.secrets,
      template: undefined,
      keys: { [keyName]: config.secrets.keys![keyName] },
    };
    void writeFileSync; // keep import for future expansion
    await generateSecrets(isolated, tmpEnv);
    secureFile(tmpEnv); // materialized plaintext secret → owner-only
    const content = readFileSync(tmpEnv, "utf-8");
    // Escape the key before interpolating into the regex — every other regex
    // builder in kit escapes; this one predates the convention (semgrep catch).
    const escapedKey = keyName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- key is regex-escaped above
    const match = content.match(new RegExp(`^${escapedKey}=(.*)$`, "m"));
    return match ? match[1] : null;
  } catch {
    return null;
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

async function cmdSecretsRevokeOld(): Promise<boolean> {
  // kit secrets revoke-old --via supabase-mgmt-api --project <ref> --key-id <id>
  const args = process.argv.slice(4);
  const via = flagValue(args, "--via");
  if (via !== "supabase-mgmt-api") {
    console.error(
      `${c.red}Usage: kit secrets revoke-old --via supabase-mgmt-api --project <ref> --key-id <id>${c.reset}`,
    );
    return false;
  }
  const projectRef = flagValue(args, "--project") ?? process.env.SUPABASE_PROJECT_REF;
  const keyId = flagValue(args, "--key-id");

  if (!projectRef) {
    console.error(`${c.red}--project <ref> required (or set SUPABASE_PROJECT_REF).${c.reset}`);
    return false;
  }
  if (!keyId) {
    console.error(
      `${c.red}--key-id <id> required. List candidates with ${c.bold}kit secrets onecli status${c.reset}${c.red} or via Supabase Dashboard.${c.reset}`,
    );
    return false;
  }

  console.log(`${c.bold}${c.cyan}kit secrets revoke-old (supabase)${c.reset}`);
  console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);

  const elev = await requireElevation("revoke-old");
  if (!elev.ok) {
    console.error(`${c.red}✗ ${elev.reason}${c.reset}`);
    return false;
  }

  const supabase = await import("sandstream-kit-plugin-supabase").catch(() => null);
  if (!supabase) {
    console.error(`${c.red}sandstream-kit-plugin-supabase not installed.${c.reset}`);
    return false;
  }
  const client = supabase.makeClient();
  const result = await supabase.revokeScopedKey(client, projectRef, keyId);

  if (!result.ok) {
    console.error(`${c.red}✗ ${result.detail}${c.reset}`);
    return false;
  }
  console.log(`  ${c.green}✓${c.reset} ${result.detail}`);
  console.log(
    `\n${c.dim}Verify with ${c.bold}kit secrets onecli status${c.reset}${c.dim} or the Supabase Dashboard.${c.reset}\n`,
  );
  return true;
}

async function cmdSecretsSet(): Promise<boolean> {
  // kit secrets set <KEY> [--value <v> | --stdin] [--store <backend>]
  // Capture-to-vault: write a user-provided value to the configured vault. This
  // is the execution behind a service's `auth = "capture"` strategy. The value
  // is read via --stdin (safer — not in argv/ps) or --value; kit reuses the
  // existing setSecretValue path, so it never echoes or logs the secret.
  const args = process.argv.slice(3);
  const keyName = process.argv[4];
  if (!keyName || keyName.startsWith("--")) {
    console.error(
      `${c.red}Usage: kit secrets set <KEY> [--value <v> | --stdin] [--store <backend>]${c.reset}`,
    );
    return false;
  }

  const config = await loadConfig(resolveConfigPath());

  // Read value: --value <v> (visible in argv/ps) or --stdin (safer).
  let value: string | undefined = flagValue(args, "--value");
  if (!value && hasFlag(args, "--stdin")) {
    value = await new Promise<string>((resolve) => {
      let buf = "";
      process.stdin.setEncoding("utf-8");
      process.stdin.on("data", (chunk: string) => {
        buf += chunk;
      });
      process.stdin.on("end", () => resolve(buf.trim()));
    });
  }
  if (!value) {
    console.error(
      `${c.red}Provide the value via --stdin (safer) or --value <v> (visible in argv/ps).${c.reset}`,
    );
    return false;
  }

  const storeOverride = flagValue(args, "--store");
  const backendOpts = pickBackendOpts(config.secrets ?? {}, keyName, { envFallback: true });

  const result = await setSecretValue(config.secrets, keyName, value, {
    ...backendOpts,
    store: storeOverride as SetValueOptions["store"],
  });

  if (!result.ok) {
    console.error(`${c.red}✗ ${result.detail}${c.reset}`);
    return false;
  }
  console.log(
    `${c.green}✓${c.reset} captured ${c.bold}${keyName}${c.reset} to the vault ${c.dim}(${result.detail})${c.reset}`,
  );
  return true;
}

async function cmdSecretsPropagateStandalone(): Promise<boolean> {
  // kit secrets propagate <KEY> --value <v> | --stdin --to <targets> [opts]
  const args = process.argv.slice(4);
  const keyName = args[0];
  if (!keyName || keyName.startsWith("--")) {
    console.error(
      `${c.red}Usage: kit secrets propagate <KEY> [--value <v> | --stdin] --to <targets> [opts]${c.reset}`,
    );
    console.error(`${c.dim}targets: ${ALL_TARGETS.join(",")}${c.reset}`);
    return false;
  }

  const targetSpec = flagValue(args, "--to");
  if (!targetSpec) {
    console.error(`${c.red}--to <targets> required${c.reset}`);
    return false;
  }
  const targets = parseTargets(targetSpec);
  if (targets.length === 0) {
    console.error(
      `${c.red}--to: no valid targets in "${targetSpec}". Valid: ${ALL_TARGETS.join(", ")}${c.reset}`,
    );
    return false;
  }

  // Read value: --value <v>, --stdin, or interactive masked prompt.
  let value: string | undefined = flagValue(args, "--value");
  if (!value && hasFlag(args, "--stdin")) {
    value = await new Promise<string>((resolve) => {
      let buf = "";
      process.stdin.setEncoding("utf-8");
      process.stdin.on("data", (chunk: string) => {
        buf += chunk;
      });
      process.stdin.on("end", () => resolve(buf.trim()));
    });
  }
  if (!value) {
    console.error(
      `${c.red}Provide value via --value <v> (visible in argv/ps) or --stdin (safer).${c.reset}`,
    );
    return false;
  }

  // Same elevation gate as rotate.
  const elev = await requireElevation("propagate");
  if (!elev.ok) {
    console.error(`${c.red}✗ ${elev.reason}${c.reset}`);
    return false;
  }

  // Parse propagation options (same flag surface as rotate --propagate).
  const propOpts: PropagationOptions = {};
  const targetEnv = flagValue(args, "--target-env");
  if (targetEnv !== undefined) propOpts.env = targetEnv as PropagationOptions["env"];
  const flyApp = flagValue(args, "--fly-app");
  if (flyApp !== undefined) propOpts.flyApp = flyApp;
  const cfWorker = flagValue(args, "--cf-worker");
  if (cfWorker !== undefined) propOpts.cfWorker = cfWorker;
  const railwayService = flagValue(args, "--railway-service");
  if (railwayService !== undefined) propOpts.railwayService = railwayService;
  const awsRegion = flagValue(args, "--aws-region");
  if (awsRegion !== undefined) propOpts.awsRegion = awsRegion;
  const ghRepo = flagValue(args, "--github-repo");
  if (ghRepo !== undefined) propOpts.githubRepo = ghRepo;
  const vercelScope = flagValue(args, "--vercel-scope");
  if (vercelScope !== undefined) propOpts.vercelScope = vercelScope;

  console.log(`${c.bold}${c.cyan}kit secrets propagate ${keyName}${c.reset}`);
  console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);
  console.log(`${c.bold}Targets:${c.reset} ${c.dim}${targets.join(", ")}${c.reset}\n`);

  const results = await propagate(keyName, value, targets, propOpts);
  let allOk = true;
  for (const r of results) {
    const icon = r.ok ? `${c.green}✓${c.reset}` : `${c.red}✗${c.reset}`;
    const argvWarn = r.valueInArgv ? `  ${c.yellow}[value in argv]${c.reset}` : "";
    console.log(`  ${icon} ${r.target.padEnd(10)}  ${c.dim}${r.detail}${c.reset}${argvWarn}`);
    if (!r.ok) allOk = false;
  }
  console.log();
  return allOk;
}

async function cmdSecretsPurgeHistory(): Promise<boolean> {
  // kit secrets purge-history <pattern> [<pattern>...] --force-history [--yes]
  const args = process.argv.slice(4);
  const force = hasFlag(args, "--force-history");
  const yes = hasFlag(args, "--yes");
  const patterns = args.filter((a) => !a.startsWith("--"));

  console.log(`${c.bold}${c.red}kit secrets purge-history${c.reset}`);
  console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);

  if (patterns.length === 0) {
    console.error(
      `${c.red}Usage: kit secrets purge-history <pattern> [more...] --force-history [--yes]${c.reset}`,
    );
    console.error(
      `${c.dim}Pattern can be a literal string (the leaked credential value) or a regex prefix.${c.reset}`,
    );
    return false;
  }

  console.log(`${c.bold}Patterns to scrub:${c.reset}`);
  for (const p of patterns) {
    const masked = p.length > 12 ? `${p.slice(0, 6)}…${p.slice(-4)}` : p;
    console.log(`  ${c.red}•${c.reset} ${masked}  ${c.dim}(${p.length} chars)${c.reset}`);
  }
  console.log();

  console.log(`${c.bold}Impact preview:${c.reset}`);
  let totalCommits = 0;
  for (const p of patterns) {
    const pv = await previewMatches(p, process.cwd());
    totalCommits += pv.matchedCommits;
    if (pv.matchedCommits === 0) {
      console.log(
        `  ${c.dim}•${c.reset} ${pv.pattern.slice(0, 14)}…  ${c.dim}no matches${c.reset}`,
      );
    } else {
      console.log(
        `  ${c.yellow}•${c.reset} ${pv.pattern.slice(0, 14)}…  ${c.yellow}${pv.matchedCommits} commit(s) touched${c.reset}`,
      );
      for (const f of pv.matchedFiles.slice(0, 5)) {
        console.log(`      ${c.dim}↳ ${f}${c.reset}`);
      }
    }
  }
  console.log();

  if (totalCommits === 0) {
    console.log(
      `${c.green}✓ No commits reference the supplied pattern(s). Nothing to do.${c.reset}\n`,
    );
    return true;
  }

  console.warn(
    `${c.red}⚠ This rewrites git history.${c.reset}\n` +
      `${c.dim}Every commit hash from the first affected commit forward changes. Required follow-ups:${c.reset}\n` +
      `  ${c.dim}1. Force-push every branch + tag to remotes${c.reset}\n` +
      `  ${c.dim}2. All teammates must DELETE their local clone and re-clone${c.reset}\n` +
      `  ${c.dim}3. CI runners + deploy pipelines that pulled from this remote must re-clone${c.reset}\n` +
      `  ${c.dim}4. The leaked credential must ALSO be rotated — scrubbing history doesn't invalidate the value${c.reset}\n`,
  );

  if (!force) {
    console.error(`${c.red}✗ Refusing to proceed without --force-history.${c.reset}`);
    console.error(
      `${c.dim}Re-run with ${c.bold}--force-history${c.reset}${c.dim} after confirming the impact list above.${c.reset}\n`,
    );
    return false;
  }

  // Must be elevated AND must explicitly confirm in interactive mode.
  // History-rewrite is irreversible — one elevation = one purge.
  const elev = await consumeElevation("purge-history");
  if (!elev.ok) {
    console.error(`${c.red}✗ ${elev.reason}${c.reset}`);
    return false;
  }

  if (!isNonInteractive() && !yes) {
    const ok = await promptConfirm(
      `Confirm DESTRUCTIVE history rewrite [type YES, default no in 15s]: `,
      15_000,
      false, // fail closed: never auto-confirm an irreversible history rewrite
    );
    if (!ok) {
      console.log(`${c.dim}Aborted.${c.reset}`);
      return false;
    }
  }

  const tools = await detectPurgeTools();
  if (!tools.filterRepoAvailable && !tools.bfgAvailable) {
    console.error(
      `${c.red}✗ Neither ${c.bold}git filter-repo${c.reset}${c.red} nor ${c.bold}bfg${c.reset}${c.red} installed.${c.reset}`,
    );
    console.error(
      `${c.dim}Install: ${c.bold}pip install git-filter-repo${c.reset}${c.dim} or ${c.bold}brew install bfg${c.reset}${c.dim}.${c.reset}\n`,
    );
    return false;
  }

  console.log(
    `${c.dim}Running ${tools.filterRepoAvailable ? "git filter-repo" : "bfg"}…${c.reset}`,
  );
  const result = await purgeHistory(patterns, process.cwd());

  if (!result.ok) {
    console.error(`${c.red}✗ ${result.detail}${c.reset}`);
    return false;
  }

  console.log(
    `  ${c.green}✓${c.reset} ${result.toolUsed} completed.  ${c.dim}${result.detail}${c.reset}`,
  );
  console.log(
    `\n${c.yellow}NEXT (manual):${c.reset}\n` +
      `  ${c.bold}git push origin --force --all${c.reset}\n` +
      `  ${c.bold}git push origin --force --tags${c.reset}\n` +
      `${c.dim}Then tell everyone with a clone to re-clone, and rotate the leaked credential if you haven't already.${c.reset}\n`,
  );

  return true;
}

async function cmdSecretsMigrate(): Promise<boolean> {
  console.log(`${c.bold}${c.cyan}kit secrets migrate${c.reset}`);
  console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);

  const config = await loadConfig(resolveConfigPath());
  if (!config.secrets?.store || config.secrets.store === "env") {
    console.log(
      `${c.yellow}No vault configured in .kit.toml — set ${c.bold}[secrets].store${c.reset}${c.yellow} first (run ${c.bold}kit init${c.reset}${c.yellow}).${c.reset}\n`,
    );
    return false;
  }

  const store = config.secrets.store;
  const dryRun = hasFlag(process.argv, "--dry-run");
  const noClean = hasFlag(process.argv, "--no-clean");

  console.log(
    `${c.dim}Target vault: ${c.bold}${store}${c.reset}${c.dim} (dry-run: ${dryRun})${c.reset}\n`,
  );

  const secretsOnly = hasFlag(process.argv, "--secrets-only");
  const plan = await planMigration(process.cwd(), { secretsOnly });
  if (plan.keyValues.size === 0) {
    if (plan.hits.length > 0) {
      console.log(
        `${c.dim}Found ${plan.hits.length} suspicious file(s) but no migratable KEY=VALUE lines.${c.reset}`,
      );
      for (const hit of plan.hits) {
        const labels = hit.findings.map((f) => `${f.label}:${f.preview}`).join(", ");
        console.log(`  ${c.dim}•${c.reset} ${hit.file}  ${c.dim}${labels}${c.reset}`);
      }
      console.log(`${c.dim}Embedded secrets in scripts / JSON need manual extraction.${c.reset}\n`);
      return false;
    }
    console.log(`${c.green}✓ No plaintext secrets found — nothing to migrate.${c.reset}\n`);
    return true;
  }

  console.log(`${c.bold}Plan${c.reset}`);
  console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);
  for (const [key, { source }] of plan.keyValues) {
    console.log(`  ${c.green}→${c.reset} ${key}  ${c.dim}(from ${source})${c.reset}`);
  }
  console.log();

  if (dryRun) {
    console.log(
      `${c.dim}--dry-run set; not writing. Remove flag to perform the migration.${c.reset}\n`,
    );
    return true;
  }

  const nonInteractive = isNonInteractive();
  if (!nonInteractive) {
    const ok = await promptConfirm(
      `Push ${plan.keyValues.size} key(s) to ${store}? [Y/n] (auto-yes in 10s): `,
      10_000,
    );
    if (!ok) {
      console.log(`${c.dim}Aborted.${c.reset}`);
      return false;
    }
  }

  // S12: gate destructive op behind explicit elevation.
  const elev = await requireElevation("migrate");
  if (!elev.ok) {
    console.error(`${c.red}✗ ${elev.reason}${c.reset}`);
    return false;
  }

  // Backend-specific options (region, project, vault name) from .kit.toml's
  // first key, with platform env-var fallbacks. Shared with the rotate flow.
  const backendOpts = pickBackendOpts(config.secrets, "", { envFallback: true });

  let fixed = 0;
  let failed = 0;
  const cleaned = new Map<string, string[]>(); // source-file → keys

  console.log();
  for (const [key, { value, source }] of plan.keyValues) {
    const result = await writeSecretToBackend(store, key, value, backendOpts);
    if (result.ok) {
      console.log(`  ${c.green}✓${c.reset} ${key}  ${c.dim}${result.detail}${c.reset}`);
      fixed++;
      if (!noClean) {
        const arr = cleaned.get(source) ?? [];
        arr.push(key);
        cleaned.set(source, arr);
      }
    } else {
      console.log(`  ${c.red}✗${c.reset} ${key}  ${c.red}${result.detail}${c.reset}`);
      failed++;
    }
  }
  console.log();

  if (cleaned.size > 0 && !noClean) {
    // Post-migration mode. Default "blank" replaces value with empty so the
    // plaintext is gone but devs still see which env vars are required.
    // Override with --keep-commented (legacy behavior) or --purge (drop the
    // line entirely).
    const mode: PostMigrateMode = hasFlag(process.argv, "--purge")
      ? "delete"
      : hasFlag(process.argv, "--keep-commented")
        ? "comment"
        : "blank";
    console.log(`${c.bold}Cleanup${c.reset}  ${c.dim}(mode=${mode})${c.reset}`);
    console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);
    for (const [file, keys] of cleaned) {
      const { changed } = await commentOutInFile(`${process.cwd()}/${file}`, keys, mode);
      const verb = mode === "delete" ? "deleted" : mode === "comment" ? "commented out" : "blanked";
      console.log(`  ${c.green}✓${c.reset} ${file}  ${c.dim}${changed} line(s) ${verb}${c.reset}`);
    }
    const explain =
      mode === "blank"
        ? "Values blanked (KEY= retained as required-var hint). Lines are safe to commit."
        : mode === "comment"
          ? "Lines commented (not deleted) — plaintext value remains; remove after verifying vault read works."
          : "Lines deleted entirely. Use .env.template / vault for required-var documentation.";
    console.log(`${c.dim}${explain}${c.reset}\n`);
  }

  console.log(
    `${fixed > 0 ? c.green : c.dim}${fixed} key(s) migrated${c.reset}${failed > 0 ? `, ${c.red}${failed} failed${c.reset}` : ""}.`,
  );
  return failed === 0;
}

/**
 * Cross-vault migration. Reads every key whose source matches --from, writes
 * to --to, rewrites .kit.toml ref. One-shot elevation (consume on use).
 *
 * Example:
 *   kit auth elevate --scope vault-migrate
 *   kit secrets vault-migrate --from 1password --to infisical --dry-run
 *   kit secrets vault-migrate --from 1password --to infisical
 */
async function cmdSecretsVaultMigrate(): Promise<boolean> {
  const args = process.argv.slice(4);
  // Via flagValue, NOT `args[args.indexOf("--from") + 1]`: `indexOf` returns -1 when the flag is
  // absent, so `+ 1` indexes args[0] and the FIRST TOKEN silently became the value. Measured:
  // `kit secrets vault-migrate --to infisical` printed `From: --to` and went on to report
  // `No keys with source="--to" found` instead of the usage text the `!fromArg` guard below is
  // there to print. `--dry-run --to infisical` yielded `From: --dry-run` the same way. A missing
  // required flag must reach that guard, not be filled in with whatever was typed first.
  const fromArg = flagValue(args, "--from") ?? "";
  const toArg = flagValue(args, "--to") ?? "";
  const dryRun = hasFlag(args, "--dry-run");

  if (hasFlag(args, "--help") || hasFlag(args, "-h") || !fromArg || !toArg) {
    console.log(
      `${c.bold}kit secrets vault-migrate${c.reset} — move keys between vault backends\n`,
    );
    console.log("Usage:");
    console.log("  kit secrets vault-migrate --from <source> --to <target> [--dry-run]");
    console.log("");
    console.log(
      "Supported backends: 1password, infisical, bitwarden, doppler, vault, aws-sm, gcp-sm, azure-kv",
    );
    console.log("");
    console.log("Migration is gated by elevation (one-shot — consumed on use):");
    console.log("  kit auth elevate --scope vault-migrate");
    return !(!fromArg || !toArg);
  }

  console.log(`${c.bold}${c.cyan}kit secrets vault-migrate${c.reset}`);
  console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);
  console.log(
    `${c.dim}From: ${c.bold}${fromArg}${c.reset}${c.dim} → To: ${c.bold}${toArg}${c.reset}${c.dim} (dry-run: ${dryRun})${c.reset}\n`,
  );

  const config = await loadConfig(resolveConfigPath());
  if (!config.secrets) {
    console.log(`${c.yellow}No [secrets] block in .kit.toml — nothing to migrate.${c.reset}\n`);
    return false;
  }

  const sourceKeys = Object.entries(config.secrets.keys ?? {}).filter(
    ([, k]) => k.source === fromArg,
  );
  if (sourceKeys.length === 0) {
    console.log(`${c.yellow}No keys with source="${fromArg}" found in .kit.toml.${c.reset}\n`);
    return false;
  }

  console.log(`${c.bold}Plan${c.reset}`);
  console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);
  for (const [name] of sourceKeys) {
    console.log(`  ${c.green}→${c.reset} ${name}`);
  }
  console.log();

  if (dryRun) {
    console.log(
      `${c.dim}--dry-run set; not reading values. Remove flag + elevate to perform.${c.reset}\n`,
    );
    return true;
  }

  // One-shot elevation: migration is destructive (writes to new vault +
  // mutates .kit.toml). Same scope used for the other one-shot ops.
  const elev = await consumeElevation("vault-migrate");
  if (!elev.ok) {
    console.error(`${c.red}✗ ${elev.reason}${c.reset}`);
    console.error(`${c.dim}Run: kit auth elevate --scope vault-migrate${c.reset}`);
    return false;
  }

  const { vaultMigrate } = await import("../secrets-vault-migrate.js");
  const result = await vaultMigrate(config as { secrets?: typeof config.secrets }, {
    from: fromArg as never,
    to: toArg as never,
    dryRun: false,
  });

  console.log(`${c.bold}Results${c.reset}`);
  console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);
  for (const item of result.items) {
    const marker = item.ok ? `${c.green}✓${c.reset}` : `${c.red}✗${c.reset}`;
    const refDetail = item.newRef ? ` ${c.dim}(${item.newRef})${c.reset}` : "";
    console.log(`  ${marker} ${item.name}  ${c.dim}${item.detail}${c.reset}${refDetail}`);
  }
  console.log();

  const failed = result.discovered - result.succeeded;
  console.log(
    `${result.succeeded > 0 ? c.green : c.dim}${result.succeeded} key(s) migrated${c.reset}${failed > 0 ? `, ${c.red}${failed} failed${c.reset}` : ""}.`,
  );

  if (result.succeeded > 0) {
    console.log(`\n${c.dim}Next steps:${c.reset}`);
    console.log(`  ${c.dim}1. Verify: kit check${c.reset}`);
    console.log(`  ${c.dim}2. Rotate values in old vault (optional but recommended):${c.reset}`);
    console.log(`     ${c.bold}kit secrets revoke-old --vault ${fromArg}${c.reset}`);
  }

  return failed === 0;
}

async function cmdSecretsSync(): Promise<boolean> {
  const args = process.argv.slice(3); // after "secrets sync"
  const targetArg = args.find((a) => a.startsWith("--target="))?.split("=")[1];
  const dryRun = hasFlag(args, "--dry-run");
  const target = (targetArg ?? "stdout") as "github" | "dotenv-ci" | "stdout";

  const config = await loadConfig(resolveConfigPath());

  if (!config.secrets) {
    console.log(`${c.dim}No secrets configured in ${KIT_FILE}${c.reset}`);
    return true;
  }

  console.log(
    `${c.bold}${c.cyan}kit secrets sync${c.reset} → ${c.bold}${target}${c.reset}${dryRun ? ` ${c.yellow}(dry run)${c.reset}` : ""}\n`,
  );

  const result = await syncSecrets(config.secrets, {
    target,
    dryRun,
    projectPath: process.cwd(),
  });

  if (result.synced.length > 0) {
    console.log(`${c.green}✓${c.reset} Synced:`);
    result.synced.forEach((k) => console.log(`  ${c.green}+${c.reset} ${k}`));
  }
  if (result.skipped.length > 0 && dryRun) {
    console.log(`${c.dim}Would sync:${c.reset}`);
    result.skipped.forEach((k) => console.log(`  ${c.dim}~ ${k}${c.reset}`));
  }
  if (result.failed.length > 0) {
    console.log(`${c.red}✗${c.reset} Failed:`);
    result.failed.forEach((k) => console.log(`  ${c.red}✗${c.reset} ${k}`));
  }

  console.log(`\n${result.message}`);
  return result.failed.length === 0;
}
