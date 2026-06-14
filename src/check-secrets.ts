import { access } from "node:fs/promises";
import type { SecretsConfig, SecretKeyConfig, InfisicalConfig } from "./config.js";
import { check1PasswordStatus } from "./onepassword.js";
import { exec } from "./utils/exec.js";


export interface SecretStatus {
  name: string;
  source: string;
  available: boolean;
  detail: string;
}

async function checkEnvSecret(name: string): Promise<{ available: boolean; detail: string }> {
  if (process.env[name]) {
    return { available: true, detail: "Set in environment" };
  }
  return { available: false, detail: "Not set in environment" };
}

interface OnePasswordCache {
  status: Awaited<ReturnType<typeof check1PasswordStatus>> | null;
}

async function check1PasswordSecret(
  ref: string,
  cache: OnePasswordCache,
): Promise<{ available: boolean; detail: string }> {
  // Cache the CLI/auth status once per checkSecrets() invocation. Without
  // this, every 1Password-backed secret triggers an identical `op whoami`
  // round-trip and emits the same error N times in the UI.
  if (!cache.status) {
    cache.status = await check1PasswordStatus();
  }
  const opStatus = cache.status;

  if (!opStatus.installed) {
    return {
      available: false,
      detail: `1Password CLI not found: ${opStatus.error}`,
    };
  }

  if (!opStatus.authenticated) {
    return {
      available: false,
      detail: `1Password not authenticated: ${opStatus.error}`,
    };
  }

  try {
    const { stdout } = await exec("op", ["read", ref, "--no-newline"], {
      timeout: 10_000,
    });
    return { available: !!stdout, detail: stdout ? "Found in 1Password" : "Empty in 1Password" };
  } catch {
    return { available: false, detail: "Not found in 1Password" };
  }
}

async function checkConfigSecret(value: string): Promise<{ available: boolean; detail: string }> {
  return { available: true, detail: "Derived from config" };
}

async function checkInfisicalSecret(
  name: string,
  infisicalConfig?: InfisicalConfig,
): Promise<{ available: boolean; detail: string }> {
  // Check for machine identity token first
  if (process.env.INFISICAL_TOKEN) {
    // Token exists, try to fetch the secret
    try {
      const args = ["export", "--format=json"];
      const env = infisicalConfig?.environment ?? "dev";
      args.push("--env", env);
      if (infisicalConfig?.project_id) {
        args.push("--projectId", infisicalConfig.project_id);
      }
      if (infisicalConfig?.path) {
        args.push("--path", infisicalConfig.path);
      }

      const { stdout } = await exec("infisical", args, {
        timeout: 15_000,
        env: { ...process.env },
      });
      const secrets = JSON.parse(stdout);
      let found = false;
      if (Array.isArray(secrets)) {
        found = secrets.some((s: { key: string }) => s.key === name);
      } else if (typeof secrets === "object" && secrets !== null) {
        found = name in secrets;
      }
      return {
        available: found,
        detail: found ? "Found in Infisical" : "Not found in Infisical",
      };
    } catch {
      return { available: false, detail: "Infisical export failed" };
    }
  }

  // Fallback: check if infisical CLI is logged in
  try {
    await exec("infisical", ["user", "get"], { timeout: 10_000 });
    return { available: true, detail: "Infisical CLI authenticated (unchecked)" };
  } catch {
    return { available: false, detail: "Infisical CLI not available or not logged in" };
  }
}

async function checkEasSecret(name: string): Promise<{ available: boolean; detail: string }> {
  try {
    const { stdout } = await exec("eas", ["secret:list", "--json"], {
      timeout: 10_000,
    });
    const secrets = JSON.parse(stdout);
    const found = Array.isArray(secrets) && secrets.some((s: { name: string }) => s.name === name);
    return {
      available: found,
      detail: found ? "Found in EAS" : "Not found in EAS",
    };
  } catch {
    return { available: false, detail: "EAS CLI not available or not authenticated" };
  }
}

async function checkBitwardenSecret(fieldName: string): Promise<{ available: boolean; detail: string }> {
  try {
    const { stdout } = await exec("bw", ["get", fieldName], {
      timeout: 10_000,
    });
    const found = !!stdout;
    return {
      available: found,
      detail: found ? "Found in Bitwarden" : "Not found in Bitwarden",
    };
  } catch {
    return { available: false, detail: "Bitwarden CLI not available or not authenticated" };
  }
}

async function checkDopplerSecret(secretName: string): Promise<{ available: boolean; detail: string }> {
  try {
    const { stdout } = await exec("doppler", ["secrets", "get", secretName, "--plain"], {
      timeout: 10_000,
    });
    const found = !!stdout;
    return {
      available: found,
      detail: found ? "Found in Doppler" : "Not found in Doppler",
    };
  } catch {
    return { available: false, detail: "Doppler CLI not available or not authenticated" };
  }
}

async function checkVaultSecret(
  config: SecretKeyConfig,
): Promise<{ available: boolean; detail: string }> {
  const path = config.vault_path || config.ref;
  const field = config.vault_field || config.name;
  if (!path || !field) {
    return {
      available: false,
      detail: "vault: vault_path and vault_field (or ref/name) required",
    };
  }
  try {
    const { stdout } = await exec("vault", ["kv", "get", "-field", field, path], {
      timeout: 10_000,
    });
    return {
      available: !!stdout.trim(),
      detail: stdout.trim() ? "Found in Vault" : "Empty in Vault",
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("permission denied") || msg.includes("403")) {
      return { available: false, detail: "Vault: permission denied (token scope)" };
    }
    if (msg.includes("ENOENT") || msg.includes("not found in $PATH")) {
      return { available: false, detail: "Vault CLI not installed" };
    }
    return { available: false, detail: "Vault: not authenticated or path missing" };
  }
}

async function checkAwsSecret(
  name: string,
  config: SecretKeyConfig,
): Promise<{ available: boolean; detail: string }> {
  const secretId = config.name || config.ref || name;
  const args = ["secretsmanager", "get-secret-value", "--secret-id", secretId, "--query", "SecretString", "--output", "text"];
  if (config.aws_region) {
    args.push("--region", config.aws_region);
  }
  try {
    const { stdout } = await exec("aws", args, { timeout: 15_000 });
    return {
      available: !!stdout.trim() && stdout.trim() !== "None",
      detail: stdout.trim() && stdout.trim() !== "None"
        ? "Found in AWS Secrets Manager"
        : "Empty in AWS Secrets Manager",
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("ResourceNotFoundException")) {
      return { available: false, detail: "AWS: secret not found" };
    }
    if (msg.includes("ExpiredToken") || msg.includes("InvalidClientTokenId")) {
      return { available: false, detail: "AWS: credentials expired or invalid (run 'aws sso login')" };
    }
    if (msg.includes("ENOENT")) {
      return { available: false, detail: "AWS CLI not installed" };
    }
    return { available: false, detail: "AWS Secrets Manager: not authenticated or region missing" };
  }
}

async function checkGcpSecret(
  name: string,
  config: SecretKeyConfig,
): Promise<{ available: boolean; detail: string }> {
  const secretName = config.name || config.ref || name;
  const version = config.gcp_version || "latest";
  const args = ["secrets", "versions", "access", version, "--secret", secretName];
  const project = config.gcp_project || process.env.GCP_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
  if (project) {
    args.push("--project", project);
  }
  try {
    const { stdout } = await exec("gcloud", args, { timeout: 15_000 });
    return {
      available: !!stdout.trim(),
      detail: stdout.trim() ? "Found in GCP Secret Manager" : "Empty in GCP Secret Manager",
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("NOT_FOUND") || msg.includes("does not exist")) {
      return { available: false, detail: "GCP: secret not found" };
    }
    if (msg.includes("PERMISSION_DENIED") || msg.includes("not authenticated")) {
      return { available: false, detail: "GCP: not authenticated (run 'gcloud auth login')" };
    }
    if (msg.includes("ENOENT")) {
      return { available: false, detail: "gcloud CLI not installed" };
    }
    return { available: false, detail: "GCP Secret Manager: not authenticated or project missing" };
  }
}

async function checkAzureSecret(
  name: string,
  config: SecretKeyConfig,
): Promise<{ available: boolean; detail: string }> {
  const secretName = config.name || config.ref || name;
  const vault = config.azure_vault || process.env.AZURE_KEYVAULT_NAME;
  if (!vault) {
    return {
      available: false,
      detail: "Azure: azure_vault or AZURE_KEYVAULT_NAME required",
    };
  }
  const args = ["keyvault", "secret", "show", "--vault-name", vault, "--name", secretName, "--query", "value", "-o", "tsv"];
  try {
    const { stdout } = await exec("az", args, { timeout: 15_000 });
    return {
      available: !!stdout.trim(),
      detail: stdout.trim() ? "Found in Azure Key Vault" : "Empty in Azure Key Vault",
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("SecretNotFound") || msg.includes("not found")) {
      return { available: false, detail: "Azure: secret not found" };
    }
    if (msg.includes("Please run 'az login'") || msg.includes("AADSTS")) {
      return { available: false, detail: "Azure: not authenticated (run 'az login')" };
    }
    if (msg.includes("ENOENT")) {
      return { available: false, detail: "Azure CLI not installed" };
    }
    return { available: false, detail: "Azure Key Vault: not authenticated or vault missing" };
  }
}

export async function checkSecrets(
  secrets: SecretsConfig,
): Promise<{ templateExists: boolean | null; keys: SecretStatus[] }> {
  let templateExists: boolean | null = null;
  if (secrets.template) {
    try {
      await access(secrets.template);
      templateExists = true;
    } catch {
      templateExists = false;
    }
  }

  const keys: SecretStatus[] = [];
  const opCache: OnePasswordCache = { status: null };

  if (secrets.keys) {
    for (const [name, config] of Object.entries(secrets.keys)) {
      let result: { available: boolean; detail: string };

       switch (config.source) {
         case "env":
           result = await checkEnvSecret(name);
           break;
         case "1password":
           result = config.ref
             ? await check1PasswordSecret(config.ref, opCache)
             : { available: false, detail: "No 1Password ref configured" };
           break;
         case "config":
           result = await checkConfigSecret(config.value || "");
           break;
         case "eas":
           result = await checkEasSecret(config.name || name);
           break;
         case "infisical":
           result = await checkInfisicalSecret(config.name || name, secrets.infisical);
           break;
         case "bitwarden":
           result = config.name || config.ref
             ? await checkBitwardenSecret(config.name || config.ref || name)
             : { available: false, detail: "No Bitwarden field name configured" };
           break;
         case "doppler":
           result = config.name
             ? await checkDopplerSecret(config.name)
             : { available: false, detail: "No Doppler secret name configured" };
           break;
         case "vault":
           result = await checkVaultSecret(config);
           break;
         case "aws-sm":
           result = await checkAwsSecret(name, config);
           break;
         case "gcp-sm":
           result = await checkGcpSecret(name, config);
           break;
         case "azure-kv":
           result = await checkAzureSecret(name, config);
           break;
         default:
           result = { available: false, detail: `Unknown source: ${config.source}` };
       }

      keys.push({
        name,
        source: config.source,
        available: result.available,
        detail: result.detail,
      });
    }
  }

  return { templateExists, keys };
}
