/**
 * Service-native rotation playbooks.
 *
 * Full automation (kit calls provider admin API → new key minted →
 * old key revoked) varies per provider and needs admin-tier credentials
 * (Stripe API platform key, AWS IAM root, GCP project owner). kit's
 * MVP gives a *guided* path instead:
 *
 *   1. Identify the provider from the key name + heuristic
 *   2. Print the exact CLI commands to mint + revoke
 *   3. Accept the new value back (`--value` after the user runs them)
 *   4. Let the existing `kit secrets rotate` flow do the vault-write
 *      + propagation
 *
 * The output is precise enough that an agent (with elevation) can pipe it
 * to its own subprocess if it has the right credentials.
 */

export interface RotationPlaybook {
  provider: "stripe" | "aws-iam" | "gcp-iam" | "github-pat" | "openai" | "unknown";
  /** Step-by-step commands the user (or an authorized agent) should run. */
  steps: string[];
  /** Where to read the resulting new value back from. */
  newValueSource: string;
  /** Notes on rollback / revoke-old flow. */
  revokeStep?: string;
  /** Documentation link for the provider's official rotation flow. */
  docsUrl?: string;
}

export function identifyProvider(keyName: string): RotationPlaybook["provider"] {
  const upper = keyName.toUpperCase();
  if (upper.startsWith("STRIPE_")) return "stripe";
  if (
    upper.startsWith("AWS_") ||
    upper === "AWS_ACCESS_KEY_ID" ||
    upper === "AWS_SECRET_ACCESS_KEY"
  )
    return "aws-iam";
  if (upper.startsWith("GCP_") || upper.endsWith("_GOOGLE_APPLICATION_CREDENTIALS"))
    return "gcp-iam";
  if (upper.startsWith("GITHUB_") || upper === "GH_TOKEN") return "github-pat";
  if (upper.startsWith("OPENAI_")) return "openai";
  return "unknown";
}

export function buildPlaybook(keyName: string): RotationPlaybook {
  const provider = identifyProvider(keyName);
  switch (provider) {
    case "stripe":
      return {
        provider,
        steps: [
          "# Use Stripe Dashboard or API to roll a restricted key:",
          "#   https://dashboard.stripe.com/apikeys",
          "# Programmatic (requires platform/account API key):",
          "stripe api_keys create --restricted --description 'kit-rotated $(date +%FT%T)' --livemode false",
          "# Capture the returned 'secret' field; that is the new value.",
        ],
        newValueSource: "Stripe API response.secret",
        revokeStep:
          "stripe api_keys revoke <old-key-id>   # after smoke-test confirms the new key works",
        docsUrl: "https://docs.stripe.com/keys-best-practices",
      };
    case "aws-iam":
      return {
        provider,
        steps: [
          "# Mint a fresh access-key pair for the same IAM user/role.",
          "# Requires IAM permission iam:CreateAccessKey on the target user.",
          "aws iam create-access-key --user-name <iam-user>",
          "# Read AccessKeyId + SecretAccessKey from the response and feed them",
          "# back into kit as a pair.",
        ],
        newValueSource: "aws iam create-access-key output",
        revokeStep:
          "aws iam update-access-key --access-key-id <old-id> --status Inactive\naws iam delete-access-key --access-key-id <old-id>",
        docsUrl: "https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_access-keys.html",
      };
    case "gcp-iam":
      return {
        provider,
        steps: [
          "# Create a new service-account key (RSA JSON or P12).",
          "gcloud iam service-accounts keys create new-key.json --iam-account=<sa-email>",
          "# Capture the contents of new-key.json (or just the private_key field).",
        ],
        newValueSource: "contents of new-key.json",
        revokeStep: "gcloud iam service-accounts keys delete <old-key-id> --iam-account=<sa-email>",
        docsUrl: "https://cloud.google.com/iam/docs/keys-create-delete",
      };
    case "github-pat":
      return {
        provider,
        steps: [
          "# GitHub doesn't expose PAT creation via an API today; rotate via UI:",
          "#   https://github.com/settings/tokens",
          "# Create a new fine-grained PAT with the same scopes/expiry as the",
          "# one you're replacing.",
        ],
        newValueSource: "GitHub settings UI",
        revokeStep: "Revoke the old PAT in the same UI (Delete button beside the entry).",
        docsUrl:
          "https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens",
      };
    case "openai":
      return {
        provider,
        steps: [
          "# OpenAI keys are dashboard-managed; create a fresh one via:",
          "#   https://platform.openai.com/api-keys",
          "# Optional: pin a per-key spend cap when you create it.",
        ],
        newValueSource: "OpenAI dashboard 'Create new secret key' modal",
        revokeStep: "Revoke the old key in the same dashboard.",
        docsUrl: "https://platform.openai.com/docs/guides/production-best-practices/api-keys",
      };
    case "unknown":
      return {
        provider,
        steps: [
          "# kit doesn't have a service-native playbook for this key.",
          "# Falling back to opaque rotation: --random generates a fresh",
          "# token, but the provider may reject anything but their own format.",
        ],
        newValueSource: "manual / provider-specific",
      };
  }
}

import { loadConfig } from "./config.js";
import { flagValue } from "./utils/flags.js";
import { enforcePolicy, supabaseRotationOp } from "./policy-gate.js";
import { resolve } from "node:path";
import { isNonInteractive } from "./environment.js";
import { writeSecretToBackend } from "./secrets-migrate.js";
import { recordSecretWrite, SECRET_WRITE_OPS } from "./secrets-write-record.js";
import { planRotation } from "./secrets-rotate.js";
import { requireElevation, consumeElevation } from "./elevation.js";
import { scopeFor } from "./elevation-scopes.js";
import {
  cmdRotateSupabaseSigningKey,
  isSigningKeyMode,
  JWT_ROLL_LEGACY_NOTICE,
  parseSupabaseMode,
} from "./secrets-rotate-signing-key.js";
import {
  propagate,
  parseTargets,
  propagationOptionsFromArgs,
  ALL_TARGETS,
  type PropagationOptions,
} from "./secrets-propagate.js";
import { promptConfirm } from "./utils/prompt.js";
import { c } from "./utils/colors.js";

function resolveConfigPath(): string {
  return resolve(process.cwd(), ".kit.toml");
}

/** `kit secrets rotate` orchestration: cmdSecretsRotate dispatches; pickBackendOpts maps key-config to write options. */
export function pickBackendOpts(
  secrets: {
    keys?: Record<
      string,
      {
        ref?: string;
        azure_vault?: string;
        gcp_project?: string;
        aws_region?: string;
        vault_path?: string;
      }
    >;
  },
  keyName: string,
  { envFallback = false }: { envFallback?: boolean } = {},
): { vault?: string; project?: string; region?: string; vaultPath?: string } {
  const opts: { vault?: string; project?: string; region?: string; vaultPath?: string } = {};
  const key = secrets.keys?.[keyName] ?? Object.values(secrets.keys ?? {})[0];
  if (key?.ref) {
    const m = key.ref.match(/^op:\/\/([^/]+)\/([^/]+)\//);
    if (m) {
      opts.vault = m[1];
      opts.project = m[2];
    }
  }
  // envFallback (migrate/rotate flows): use the platform's standard env vars when .kit.toml pins
  // nothing. Never clobber a value derived from the 1Password ref above.
  if (key?.azure_vault) opts.vault = key.azure_vault;
  else if (envFallback && !opts.vault && process.env.AZURE_KEYVAULT_NAME)
    opts.vault = process.env.AZURE_KEYVAULT_NAME;
  if (key?.gcp_project) opts.project = key.gcp_project;
  else if (
    envFallback &&
    !opts.project &&
    (process.env.GCP_PROJECT || process.env.GOOGLE_CLOUD_PROJECT)
  )
    opts.project = process.env.GCP_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
  if (key?.aws_region) opts.region = key.aws_region;
  else if (envFallback && process.env.AWS_REGION) opts.region = process.env.AWS_REGION;
  if (key?.vault_path) opts.vaultPath = key.vault_path;
  return opts;
}

type SupabasePlugin = typeof import("sandstream-kit-plugin-supabase");
type SupabasePreview = Awaited<ReturnType<SupabasePlugin["previewSupabaseRotation"]>>;
type RotateMode = "scoped-key-mint" | "jwt-secret-roll";

/** Project ref from `--project <ref>` or SUPABASE_PROJECT_REF; null (after the error) when missing. */
function readProjectRef(args: string[]): string | null {
  const projectRef = flagValue(args, "--project") ?? process.env.SUPABASE_PROJECT_REF;
  if (projectRef) return projectRef;
  console.error(`${c.red}--project <ref> required (or set SUPABASE_PROJECT_REF).${c.reset}`);
  console.error(
    `${c.dim}Find your project ref at https://supabase.com/dashboard/project/_/settings/general (URL contains the ref).${c.reset}`,
  );
  return null;
}

/** Preview pass: confirms the PAT works and detects which mode the project supports. */
async function previewRotation(
  supabase: SupabasePlugin,
  projectRef: string,
): Promise<SupabasePreview | null> {
  const preview = await supabase.previewSupabaseRotation({ projectRef });
  if (!preview.ok) {
    console.error(`${c.red}✗ Supabase Management API: ${preview.error}${c.reset}`);
    return null;
  }
  console.log(
    `${c.dim}PAT verified. Project has ${preview.existingKeyCount} API key(s).${c.reset}`,
  );
  if (preview.keyMode) {
    console.log(
      `${c.dim}Key mode: scoped=${preview.keyMode.supportsScopedKeys}, legacy-jwt=${preview.keyMode.supportsLegacyJwt}${c.reset}`,
    );
  }
  return preview;
}

/** Explicit scoped-key-mint on a legacy-JWT project needs --force (the 2026-06-03 prod break). True = refused. */
function refusesLegacyScopedMint(
  preview: SupabasePreview,
  mode: RotateMode,
  explicitMode: boolean,
  force: boolean,
): boolean {
  const keyMode = preview.keyMode;
  if (!explicitMode || !keyMode || mode !== "scoped-key-mint") return false;
  if (keyMode.supportsScopedKeys || !keyMode.supportsLegacyJwt) return false;
  console.error(
    `${c.red}✗ Refusing scoped-key-mint: project still uses legacy JWT keys.${c.reset}`,
  );
  console.error(
    `${c.dim}A scoped key minted now would be treated as anon by PostgREST and break every service_role call.${c.reset}`,
  );
  console.error(
    `${c.dim}Recommended: ${c.bold}--mode signing-key-cutover${c.reset}${c.dim} (legacy: --mode jwt-secret-roll) or migrate the project to scoped keys first.${c.reset}`,
  );
  if (!force) {
    console.error(
      `${c.dim}Override with ${c.bold}--force${c.reset}${c.dim} if you know what you're doing.${c.reset}\n`,
    );
    return true;
  }
  console.error(
    `${c.yellow}--force set; proceeding with scoped-key-mint despite incompatibility.${c.reset}\n`,
  );
  return false;
}

function printModeWarnings(
  preview: SupabasePreview,
  mode: RotateMode,
  explicitMode: boolean,
): void {
  if (preview.warning && !explicitMode) {
    console.log(`${c.yellow}⚠ ${preview.warning}${c.reset}`);
  }
  if (mode === "jwt-secret-roll") {
    console.warn(
      `${c.yellow}⚠ jwt-secret-roll invalidates EVERY existing token (anon, service_role, signed URLs, active sessions).${c.reset}`,
    );
    console.warn(`${c.yellow}⚠ ${JWT_ROLL_LEGACY_NOTICE}${c.reset}`);
  }
}

/** S12 elevation. The scope comes from the mode (elevation-scopes.ts), so the one-shot cutover needs its own. */
async function elevateForRotation(mode: RotateMode): Promise<boolean> {
  const rotateScope = scopeFor("rotate", mode).scope;
  const elev =
    mode === "jwt-secret-roll"
      ? await consumeElevation(rotateScope)
      : await requireElevation(rotateScope);
  if (elev.ok) return true;
  console.error(`${c.red}✗ ${elev.reason}${c.reset}`);
  return false;
}

/** False only when the operator declines the destructive jwt-secret-roll. */
async function confirmRotation(mode: RotateMode): Promise<boolean> {
  if (isNonInteractive()) return true;
  const roll = mode === "jwt-secret-roll";
  const confirmMsg = roll
    ? `Confirm jwt-secret-roll (HARD CUTOVER) [y/N, auto-no in 15s]: `
    : `Mint new scoped key? [Y/n, auto-yes in 10s]: `;
  // The roll is irreversible ("auto-no": fail closed on walk-away/pipe); the mint is additive ("auto-yes").
  const ok = await promptConfirm(confirmMsg, roll ? 15_000 : 10_000, !roll);
  if (!ok && roll) console.log(`${c.dim}Aborted.${c.reset}`);
  return ok || !roll;
}

/** `[policy.agent_writes.supabase]` narrows only. The op mirrors `--mode`: allowing the mint does not allow the roll. */
async function policyAllowsRotation(mode: RotateMode): Promise<boolean> {
  const rotatePolicy = (await loadConfig(resolveConfigPath()).catch(() => null))?.policy;
  const refusal = await enforcePolicy(rotatePolicy, "supabase", supabaseRotationOp(mode));
  if (!refusal) return true;
  console.error(`${c.red}✗ refused by [policy.agent_writes]: ${refusal.reason}${c.reset}`);
  return false;
}

/** Writes the new value through the vault-write path, or prints it once when no vault is set. */
async function storeRotatedValue(keyName: string, newValue: string): Promise<boolean> {
  const config = await loadConfig(resolveConfigPath());
  if (!config.secrets?.store || config.secrets.store === "env") {
    console.warn(
      `${c.yellow}⚠ No upstream vault configured. New value printed once below — copy it now.${c.reset}\n`,
    );
    console.log(`${newValue}\n`);
    return true;
  }
  const writeResult = await writeSecretToBackend(
    config.secrets.store,
    keyName,
    newValue,
    pickBackendOpts(config.secrets, keyName),
  );
  await recordSecretWrite(SECRET_WRITE_OPS.rotate, {
    keys: [keyName],
    target: config.secrets.store,
    ok: writeResult.ok,
  });
  if (!writeResult.ok) {
    console.error(`${c.red}✗ vault write failed: ${writeResult.detail}${c.reset}`);
    console.error(
      `${c.yellow}New value (copy now — it won't be shown again):${c.reset}\n${newValue}\n`,
    );
    return false;
  }
  console.log(`  ${c.green}✓${c.reset} wrote to vault (${config.secrets.store})`);
  console.log(
    `\n${c.dim}Next: re-run with ${c.bold}--propagate vercel,github${c.reset}${c.dim} to push to deploy targets.${c.reset}\n`,
  );
  return true;
}

/** Lazy-imports the workspace plugin so kit core boots fine without it. */
async function loadSupabasePlugin(): Promise<SupabasePlugin | null> {
  const supabase = await import("sandstream-kit-plugin-supabase").catch(() => null);
  if (supabase) return supabase;
  console.error(
    `${c.red}sandstream-kit-plugin-supabase not installed. Run ${c.bold}npm install sandstream-kit-plugin-supabase${c.reset}${c.red} or build the workspace.${c.reset}`,
  );
  return null;
}

/** Calls the plugin and returns the new key or JWT secret; null (after the error) on failure. */
async function rotateKey(
  supabase: SupabasePlugin,
  projectRef: string,
  mode: RotateMode,
): Promise<string | null> {
  const outcome = await supabase.rotateSupabaseKey({ projectRef, mode });
  if (!outcome.ok || !outcome.result) {
    console.error(`${c.red}✗ ${outcome.error ?? "rotation failed"}${c.reset}`);
    return null;
  }
  const newValue = outcome.result.newKey ?? outcome.result.newJwtSecret;
  if (!newValue) {
    console.error(
      `${c.red}✗ Rotation completed but no key was returned in the response. Check the Supabase Dashboard.${c.reset}`,
    );
    return null;
  }
  console.log(
    `  ${c.green}✓${c.reset} ${mode} succeeded.  ${c.dim}new value is ${newValue.length} chars${c.reset}`,
  );
  return newValue;
}

async function cmdSecretsRotateSupabaseMgmt(keyName: string, args: string[]): Promise<boolean> {
  console.log(`${c.bold}${c.cyan}kit secrets rotate --via supabase-mgmt-api${c.reset}`);
  console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);

  const projectRef = readProjectRef(args);
  if (!projectRef) return false;

  // Rotation mode: explicit --mode, otherwise auto-detect from project state.
  const parsed = parseSupabaseMode(flagValue(args, "--mode"));
  if (parsed === "invalid") return false;
  if (isSigningKeyMode(parsed)) return await cmdRotateSupabaseSigningKey(projectRef, parsed, args);
  const explicitMode = parsed !== undefined;

  const supabase = await loadSupabasePlugin();
  if (!supabase) return false;

  const preview = await previewRotation(supabase, projectRef);
  if (!preview) return false;
  const mode: RotateMode = parsed ?? ((preview.recommendedMode ?? "scoped-key-mint") as RotateMode);
  console.log(
    `${c.dim}Mode: ${c.bold}${mode}${c.reset}${c.dim}${explicitMode ? "" : " (auto)"}${c.reset}`,
  );
  if (refusesLegacyScopedMint(preview, mode, explicitMode, args.includes("--force"))) return false;
  printModeWarnings(preview, mode, explicitMode);
  console.log();

  if (args.includes("--dry-run")) {
    console.log(`${c.dim}--dry-run: not rotating. Remove flag to proceed.${c.reset}\n`);
    return true;
  }
  if (!(await elevateForRotation(mode))) return false;
  if (!(await confirmRotation(mode))) return false;
  if (!(await policyAllowsRotation(mode))) return false;

  const newValue = await rotateKey(supabase, projectRef, mode);
  if (!newValue) return false;
  return await storeRotatedValue(keyName, newValue);
}

export async function cmdSecretsRotate(): Promise<boolean> {
  console.log(`${c.bold}${c.cyan}kit secrets rotate${c.reset}`);
  console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);

  const args = process.argv.slice(4);
  const keyName = args[0];
  if (!keyName || keyName.startsWith("--")) {
    console.error(
      `${c.red}Usage: kit secrets rotate <KEY> [--value <new>] [--random [N]] [--dry-run]${c.reset}`,
    );
    return false;
  }

  const explicitValue = flagValue(args, "--value");
  // `--random` takes an OPTIONAL value: bare means "generate", `--random 32` / `--random=32` a length.
  // Presence and value are read separately: the digit test keeps `--random --dry-run` meaning
  // "generate", and `hasFlag` compares whole tokens, so it would drop `--random=32`.
  const randomPresent = args.some((a) => a === "--random" || a.startsWith("--random="));
  let randomFlag: number | true | undefined;
  if (randomPresent) {
    const next = flagValue(args, "--random");
    randomFlag = next && /^\d+$/.test(next) ? Number.parseInt(next, 10) : true;
  }
  const dryRun = args.includes("--dry-run");
  const fromCli = args.includes("--from-cli");
  const via = flagValue(args, "--via");

  // ── Supabase Management API rotation ─────────────────────────────────────
  if (via === "supabase-mgmt-api") {
    return await cmdSecretsRotateSupabaseMgmt(keyName, args);
  }

  // ── R3: service-native playbook ──────────────────────────────────────────
  // --from-cli prints the provider's rotation steps BEFORE asking for --value: run the provider
  // CLI, copy the new value, then re-run `kit secrets rotate <KEY> --value <new>`.
  if (fromCli) {
    const playbook = buildPlaybook(keyName);
    console.log(`${c.bold}${c.cyan}kit secrets rotate --from-cli${c.reset}`);
    console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);
    console.log(
      `${c.bold}Provider:${c.reset} ${c.bold}${playbook.provider}${c.reset}  ${c.dim}(detected from key name)${c.reset}\n`,
    );
    console.log(`${c.bold}Steps to mint the new credential:${c.reset}`);
    for (const step of playbook.steps) {
      const isComment = step.startsWith("#");
      console.log(isComment ? `  ${c.dim}${step}${c.reset}` : `  ${c.green}$${c.reset} ${step}`);
    }
    console.log();
    console.log(
      `${c.bold}New value source:${c.reset} ${c.dim}${playbook.newValueSource}${c.reset}`,
    );
    if (playbook.revokeStep) {
      console.log(`${c.bold}Revoke the old key (after smoke-test):${c.reset}`);
      for (const line of playbook.revokeStep.split("\n")) {
        console.log(`  ${c.yellow}$${c.reset} ${line}`);
      }
    }
    if (playbook.docsUrl) {
      console.log(`${c.dim}Docs: ${playbook.docsUrl}${c.reset}`);
    }
    console.log();
    console.log(
      `${c.dim}When you have the new value, re-run: ${c.bold}kit secrets rotate ${keyName} --value <new>${c.reset}${c.dim} (or pipe it with --value file:///path).${c.reset}\n`,
    );
    return true;
  }

  const config = await loadConfig(resolveConfigPath());
  if (!config.secrets?.store || config.secrets.store === "env") {
    console.error(
      `${c.red}No vault configured in .kit.toml — set ${c.bold}[secrets].store${c.reset}${c.red} first.${c.reset}`,
    );
    return false;
  }

  const result = planRotation(keyName, config.secrets, {
    value: explicitValue,
    random: randomFlag,
  });

  if ("error" in result) {
    console.error(`${c.red}${result.error}${c.reset}`);
    return false;
  }

  const { plan, value } = result;
  console.log(
    `${c.bold}Plan${c.reset}  ${c.dim}rotate ${plan.key} → ${plan.store} (source: ${plan.source}, ${plan.newValueLength} chars)${c.reset}\n`,
  );

  if (dryRun) {
    console.log(`${c.dim}--dry-run: not writing. Remove flag to perform rotation.${c.reset}\n`);
    return true;
  }

  // S12: gate destructive op behind explicit elevation.
  const elev = await requireElevation("rotate");
  if (!elev.ok) {
    console.error(`${c.red}✗ ${elev.reason}${c.reset}`);
    return false;
  }

  // Same backend options as the migrate flow: vault, region, project, Azure vault.
  const backendOpts = pickBackendOpts(config.secrets, keyName, { envFallback: true });

  const writeResult = await writeSecretToBackend(plan.store, plan.key, value, backendOpts);
  await recordSecretWrite(SECRET_WRITE_OPS.rotate, {
    keys: [plan.key],
    target: plan.store ?? "vault",
    ok: writeResult.ok,
  });

  if (!writeResult.ok) {
    console.error(`${c.red}✗ ${writeResult.detail}${c.reset}`);
    return false;
  }

  console.log(`  ${c.green}✓${c.reset} ${writeResult.detail}\n`);

  // ── R2: propagate to deploy platforms ────────────────────────────────────
  const propagatePresent = args.some((a) => a === "--propagate" || a.startsWith("--propagate="));
  if (propagatePresent) {
    const spec = flagValue(args, "--propagate");
    const targets = spec ? parseTargets(spec) : [];
    if (targets.length === 0) {
      console.error(
        `${c.red}--propagate requires comma list. Valid: ${ALL_TARGETS.join(", ")}${c.reset}`,
      );
      return false;
    }

    const propOpts: PropagationOptions = propagationOptionsFromArgs(args);
    // Same gate as `kit secrets propagate` — rotation must not be the way around the policy.
    if (config.policy) propOpts.policy = config.policy;

    console.log(`${c.bold}Propagation${c.reset}  ${c.dim}→ ${targets.join(", ")}${c.reset}\n`);
    const results = await propagate(plan.key, value, targets, propOpts);
    let propAllOk = true;
    for (const r of results) {
      const icon = r.ok ? `${c.green}✓${c.reset}` : `${c.red}✗${c.reset}`;
      const argvWarn = r.valueInArgv ? `  ${c.yellow}[value in argv]${c.reset}` : "";
      console.log(`  ${icon} ${r.target.padEnd(10)}  ${c.dim}${r.detail}${c.reset}${argvWarn}`);
      if (!r.ok) propAllOk = false;
    }
    console.log();
    if (!propAllOk) {
      console.log(
        `${c.yellow}Some propagations failed — check CLI auth (vercel/gh/fly/wrangler/railway/aws) and retry with the same value.${c.reset}\n`,
      );
    }
  } else {
    console.log(`${c.bold}Next steps${c.reset}`);
    console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);
    for (const target of plan.externalTargets) {
      console.log(`  ${c.yellow}→${c.reset} update ${target}`);
    }
    console.log();
    console.log(
      `${c.dim}Or re-run with ${c.bold}--propagate vercel,github,fly,cloudflare,railway,aws-ssm${c.reset}${c.dim} to push automatically.${c.reset}\n`,
    );
  }

  return true;
}
