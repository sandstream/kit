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
import { resolve } from "node:path";
import { isNonInteractive } from "./environment.js";
import { writeSecretToBackend } from "./secrets-migrate.js";
import { planRotation } from "./secrets-rotate.js";
import { requireElevation, consumeElevation } from "./elevation.js";
import {
  propagate,
  parseTargets,
  ALL_TARGETS,
  type PropagationOptions,
} from "./secrets-propagate.js";
import { promptConfirm } from "./utils/prompt.js";
import { c } from "./utils/colors.js";

function resolveConfigPath(): string {
  return resolve(process.cwd(), ".kit.toml");
}

/**
 * `kit secrets rotate` CLI orchestration — extracted from cli.ts
 * (codebase-review follow-up). cmdSecretsRotate is the dispatch entry;
 * cmdSecretsRotateSupabaseMgmt handles the fully-automated Supabase
 * Mgmt-API path; pickBackendOpts maps .kit.toml key-config to
 * backend-write options.
 */
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
  // envFallback (migrate/rotate flows): fall back to the platform's standard env
  // vars when the .kit.toml key doesn't pin a value. Never clobber a value
  // already derived from the 1Password ref above.
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

async function cmdSecretsRotateSupabaseMgmt(keyName: string, args: string[]): Promise<boolean> {
  console.log(`${c.bold}${c.cyan}kit secrets rotate --via supabase-mgmt-api${c.reset}`);
  console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);

  // Project ref: --project <ref> flag or SUPABASE_PROJECT_REF env var.
  const projectIdx = args.indexOf("--project");
  const projectRef = projectIdx >= 0 ? args[projectIdx + 1] : process.env.SUPABASE_PROJECT_REF;
  if (!projectRef) {
    console.error(`${c.red}--project <ref> required (or set SUPABASE_PROJECT_REF).${c.reset}`);
    console.error(
      `${c.dim}Find your project ref at https://supabase.com/dashboard/project/_/settings/general (URL contains the ref).${c.reset}`,
    );
    return false;
  }

  // Rotation mode: explicit --mode, otherwise auto-detect from project state.
  const modeIdx = args.indexOf("--mode");
  let mode: "scoped-key-mint" | "jwt-secret-roll" | undefined =
    modeIdx >= 0 ? (args[modeIdx + 1] as "scoped-key-mint" | "jwt-secret-roll") : undefined;
  if (mode !== undefined && mode !== "scoped-key-mint" && mode !== "jwt-secret-roll") {
    console.error(
      `${c.red}Invalid --mode "${mode}" — use "scoped-key-mint" or "jwt-secret-roll".${c.reset}`,
    );
    return false;
  }
  const explicitMode = mode !== undefined;

  const dryRun = args.includes("--dry-run");
  const force = args.includes("--force");

  // Lazy-import the workspace plugin so kit core boots fine without it.
  const supabase = await import("sandstream-kit-plugin-supabase").catch(() => null);
  if (!supabase) {
    console.error(
      `${c.red}sandstream-kit-plugin-supabase not installed. Run ${c.bold}npm install sandstream-kit-plugin-supabase${c.reset}${c.red} or build the workspace.${c.reset}`,
    );
    return false;
  }

  // Preview pass — confirms the PAT works AND detects which mode is
  // compatible. Today's incident was caused by minting a scoped key in a
  // project that PostgREST still treats as JWT-only.
  const preview = await supabase.previewSupabaseRotation({ projectRef });
  if (!preview.ok) {
    console.error(`${c.red}✗ Supabase Management API: ${preview.error}${c.reset}`);
    return false;
  }
  console.log(
    `${c.dim}PAT verified. Project has ${preview.existingKeyCount} API key(s).${c.reset}`,
  );
  if (preview.keyMode) {
    console.log(
      `${c.dim}Key mode: scoped=${preview.keyMode.supportsScopedKeys}, legacy-jwt=${preview.keyMode.supportsLegacyJwt}${c.reset}`,
    );
  }

  // Default to the recommended mode when the user didn't pin one.
  if (!mode) {
    mode = (preview.recommendedMode ?? "scoped-key-mint") as "scoped-key-mint" | "jwt-secret-roll";
  }
  console.log(
    `${c.dim}Mode: ${c.bold}${mode}${c.reset}${c.dim}${explicitMode ? "" : " (auto)"}${c.reset}`,
  );

  // If the explicit mode conflicts with what the project supports, warn
  // loudly and require --force. This is the gate that would have prevented
  // the 2026-06-03 prod break.
  if (
    explicitMode &&
    preview.keyMode &&
    mode === "scoped-key-mint" &&
    !preview.keyMode.supportsScopedKeys &&
    preview.keyMode.supportsLegacyJwt
  ) {
    console.error(
      `${c.red}✗ Refusing scoped-key-mint: project still uses legacy JWT keys.${c.reset}`,
    );
    console.error(
      `${c.dim}A scoped key minted now would be treated as anon by PostgREST and break every service_role call.${c.reset}`,
    );
    console.error(
      `${c.dim}Recommended: ${c.bold}--mode jwt-secret-roll${c.reset}${c.dim} (invalidates all tokens) or migrate the project to scoped keys first.${c.reset}`,
    );
    if (!force) {
      console.error(
        `${c.dim}Override with ${c.bold}--force${c.reset}${c.dim} if you know what you're doing.${c.reset}\n`,
      );
      return false;
    }
    console.error(
      `${c.yellow}--force set; proceeding with scoped-key-mint despite incompatibility.${c.reset}\n`,
    );
  }

  if (preview.warning && !explicitMode) {
    console.log(`${c.yellow}⚠ ${preview.warning}${c.reset}`);
  }

  if (mode === "jwt-secret-roll") {
    console.warn(
      `${c.yellow}⚠ jwt-secret-roll invalidates EVERY existing token (anon, service_role, signed URLs, active sessions).${c.reset}`,
    );
  }
  console.log();

  if (dryRun) {
    console.log(`${c.dim}--dry-run: not rotating. Remove flag to proceed.${c.reset}\n`);
    return true;
  }

  // S12 elevation required for rotation. jwt-secret-roll is a hard cutover
  // — one elevation = one rotation. Other modes (scoped-key-mint with
  // rollback) keep the standard 15-min TTL.
  const elev =
    mode === "jwt-secret-roll"
      ? await consumeElevation("rotate")
      : await requireElevation("rotate");
  if (!elev.ok) {
    console.error(`${c.red}✗ ${elev.reason}${c.reset}`);
    return false;
  }

  // Interactive confirmation for jwt-secret-roll (destructive); a YES prompt
  // for scoped-key-mint is enough since old tokens stay live.
  if (!isNonInteractive()) {
    const confirmMsg =
      mode === "jwt-secret-roll"
        ? `Confirm jwt-secret-roll (HARD CUTOVER) [y/N, auto-no in 15s]: `
        : `Mint new scoped key? [Y/n, auto-yes in 10s]: `;
    // jwt-secret-roll is an irreversible HARD CUTOVER and its prompt promises
    // "auto-no" — fail closed on walk-away/pipe. Scoped-key mint is additive → auto-yes.
    const ok = await promptConfirm(
      confirmMsg,
      mode === "jwt-secret-roll" ? 15_000 : 10_000,
      mode !== "jwt-secret-roll",
    );
    if (!ok && mode === "jwt-secret-roll") {
      console.log(`${c.dim}Aborted.${c.reset}`);
      return false;
    }
  }

  const outcome = await supabase.rotateSupabaseKey({ projectRef, mode });
  if (!outcome.ok || !outcome.result) {
    console.error(`${c.red}✗ ${outcome.error ?? "rotation failed"}${c.reset}`);
    return false;
  }

  const newValue = outcome.result.newKey ?? outcome.result.newJwtSecret;
  if (!newValue) {
    console.error(
      `${c.red}✗ Rotation completed but no key was returned in the response. Check the Supabase Dashboard.${c.reset}`,
    );
    return false;
  }

  console.log(
    `  ${c.green}✓${c.reset} ${mode} succeeded.  ${c.dim}new value is ${newValue.length} chars${c.reset}`,
  );

  // Wire through the existing vault-write path so the new value lands in
  // the configured upstream vault and the placeholder logic stays consistent.
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

  const valueIdx = args.indexOf("--value");
  const explicitValue = valueIdx >= 0 ? args[valueIdx + 1] : undefined;
  const randomIdx = args.indexOf("--random");
  let randomFlag: number | true | undefined;
  if (randomIdx >= 0) {
    const next = args[randomIdx + 1];
    if (next && /^\d+$/.test(next)) {
      randomFlag = Number.parseInt(next, 10);
    } else {
      randomFlag = true;
    }
  }
  const dryRun = args.includes("--dry-run");
  const fromCli = args.includes("--from-cli");
  const viaIdx = args.indexOf("--via");
  const via = viaIdx >= 0 ? args[viaIdx + 1] : undefined;

  // ── Supabase Management API rotation ─────────────────────────────────────
  if (via === "supabase-mgmt-api") {
    return await cmdSecretsRotateSupabaseMgmt(keyName, args);
  }

  // ── R3: service-native playbook ──────────────────────────────────────────
  // When --from-cli is set, print the provider-specific rotation steps
  // BEFORE asking for --value. Useful as a guided workflow: the user
  // (or an authorized agent) runs the provider CLI, copies the new
  // value, then re-runs `kit secrets rotate <KEY> --value <new>`.
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

  // Build the same backend-options the migrate flow uses so we land in the
  // right vault / region / project / Azure vault.
  const backendOpts = pickBackendOpts(config.secrets, keyName, { envFallback: true });

  const writeResult = await writeSecretToBackend(plan.store, plan.key, value, backendOpts);

  if (!writeResult.ok) {
    console.error(`${c.red}✗ ${writeResult.detail}${c.reset}`);
    return false;
  }

  console.log(`  ${c.green}✓${c.reset} ${writeResult.detail}\n`);

  // ── R2: propagate to deploy platforms ────────────────────────────────────
  const propagateIdx = args.indexOf("--propagate");
  if (propagateIdx >= 0) {
    const spec = args[propagateIdx + 1];
    const targets = spec ? parseTargets(spec) : [];
    if (targets.length === 0) {
      console.error(
        `${c.red}--propagate requires comma list. Valid: ${ALL_TARGETS.join(", ")}${c.reset}`,
      );
      return false;
    }

    const propOpts: PropagationOptions = {};
    const envIdx = args.indexOf("--target-env");
    if (envIdx >= 0) propOpts.env = args[envIdx + 1] as PropagationOptions["env"];
    const flyAppIdx = args.indexOf("--fly-app");
    if (flyAppIdx >= 0) propOpts.flyApp = args[flyAppIdx + 1];
    const cfWorkerIdx = args.indexOf("--cf-worker");
    if (cfWorkerIdx >= 0) propOpts.cfWorker = args[cfWorkerIdx + 1];
    const railwayServiceIdx = args.indexOf("--railway-service");
    if (railwayServiceIdx >= 0) propOpts.railwayService = args[railwayServiceIdx + 1];
    const awsRegionIdx = args.indexOf("--aws-region");
    if (awsRegionIdx >= 0) propOpts.awsRegion = args[awsRegionIdx + 1];
    const ghRepoIdx = args.indexOf("--github-repo");
    if (ghRepoIdx >= 0) propOpts.githubRepo = args[ghRepoIdx + 1];
    const vercelScopeIdx = args.indexOf("--vercel-scope");
    if (vercelScopeIdx >= 0) propOpts.vercelScope = args[vercelScopeIdx + 1];

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
