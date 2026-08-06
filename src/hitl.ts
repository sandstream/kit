import type { kitConfig } from "./config.js";
import type { ServiceStatus } from "./check-services.js";
import type { SecretStatus } from "./check-secrets.js";
import type { SecurityCheckResult } from "./check-security.js";
import type { DeployCheckResult } from "./check-deploy.js";
import { SERVICE_BY_ID } from "./service-registry.js";

export type HitlOwner = "human" | "developer" | "provider admin";

export interface HitlBlock {
  blocker: string;
  owner: HitlOwner;
  reason: string;
  steps: string[];
  respondWith: string;
  agentContinuesWith: string;
}

function stripInfoCommand(command: string | undefined): string {
  return (command ?? "").trim().replace(/^#\s*/, "");
}

function serviceSecretKeys(name: string, config: kitConfig): string[] {
  const registryKeys = SERVICE_BY_ID[name]?.secrets ?? [];
  if (registryKeys.length === 0) return [];

  const declared = new Set(Object.keys(config.secrets?.keys ?? {}));
  return registryKeys.filter((k) => declared.size === 0 || declared.has(k));
}

export function hitlBlockForService(service: ServiceStatus, config: kitConfig): HitlBlock | null {
  if (service.authenticated) return null;

  const svc = config.services?.[service.name];
  const loginCmd = (svc?.login ?? "").trim();
  const checkCmd = stripInfoCommand(svc?.check);
  const keys = serviceSecretKeys(service.name, config);
  const steps: string[] = [];

  if (!loginCmd) {
    steps.push(`Ask a human with provider access to configure ${service.name} from .kit.toml.`);
  } else if (loginCmd.startsWith("#")) {
    steps.push(`Ask a human with provider access to ${stripInfoCommand(loginCmd)}.`);
  } else {
    steps.push(
      `Run \`kit login --service ${service.name}\` in a normal terminal/browser session, or run \`${loginCmd}\`.`,
    );
  }

  if (keys.length > 0) {
    steps.push(
      `Configure these key names, never their values in chat: ${keys.join(", ")}. Use \`kit secrets set <KEY> --stdin\` or the configured vault/env.`,
    );
  }

  if (checkCmd) {
    steps.push(`Verify: ${checkCmd}.`);
  } else if (service.output.trim()) {
    steps.push(`Verify: ${service.output.trim()}.`);
  }

  const reason = service.informational
    ? "provider UI / external account / secret"
    : "auth / browser / external account";

  return {
    blocker: service.informational
      ? `${service.name} requires manual provider configuration`
      : `${service.name} is not authenticated`,
    owner: "provider admin",
    reason,
    steps,
    respondWith: `${service.name} configured/authenticated; no secret values pasted`,
    agentContinuesWith: "kit check --category services,secrets",
  };
}

function secretSetupStep(source: string, names: string[]): string {
  const list = names.join(", ");
  switch (source) {
    case "env":
      return `Set ${list} in the local environment or capture it with \`kit secrets set <KEY> --stdin\`.`;
    case "1password":
      return "Run `op signin`, or set `OP_SERVICE_ACCOUNT_TOKEN` for headless/CI access.";
    case "infisical":
      return "Run `infisical login` and select the project, or set `INFISICAL_TOKEN`.";
    case "bitwarden":
      return "Run `bw login` and `bw unlock`, then verify the referenced item/field exists.";
    case "doppler":
      return "Run `doppler login` and `doppler setup`, then verify the secret exists.";
    case "vault":
      return "Run `vault login`, then verify `vault_path`/`vault_field` in .kit.toml.";
    case "aws-sm":
      return "Run `aws sso login` or configure IAM credentials and region for AWS Secrets Manager.";
    case "gcp-sm":
      return "Run `gcloud auth login`, set the project, and verify the Secret Manager secret exists.";
    case "azure-kv":
      return "Run `az login`, set the Key Vault, and verify the secret exists.";
    case "eas":
      return "Run `eas login`, then add the secret with EAS.";
    case "config":
      return `Replace empty/placeholder config value(s) for ${list}, or move them to a vault.`;
    default:
      return `Configure ${list} in the ${source} backend.`;
  }
}

function secretReason(source: string, details: string[]): string {
  const joined = details.join(" ").toLowerCase();
  if (
    /not authenticated|not logged in|signin|login|credentials expired|invalid|permission denied/.test(
      joined,
    )
  ) {
    return "secret backend auth";
  }
  if (/not installed|cli not available|enoent/.test(joined)) return "secret backend setup";
  return source === "env" || source === "config" ? "secret / config" : "secret / external account";
}

export function hitlBlocksForSecrets(secrets: SecretStatus[]): HitlBlock[] {
  const missing = secrets.filter((s) => !s.available);
  const grouped = new Map<string, SecretStatus[]>();
  for (const s of missing) {
    const key = `${s.source}\0${secretReason(s.source, [s.detail])}`;
    grouped.set(key, [...(grouped.get(key) ?? []), s]);
  }

  return [...grouped.entries()].map(([key, items]) => {
    const [source, reason] = key.split("\0") as [string, string];
    const names = items.map((s) => s.name);
    return {
      blocker: `${names.length} ${source} secret${names.length === 1 ? "" : "s"} unavailable: ${names.join(", ")}`,
      owner: "developer",
      reason,
      steps: [secretSetupStep(source, names), "Run `kit check --category secrets`."],
      respondWith: `${names.join(", ")} available; no secret values pasted`,
      agentContinuesWith: "kit check --category services,secrets",
    };
  });
}

export function hitlBlocksForSecurity(results: SecurityCheckResult[]): HitlBlock[] {
  return results
    .filter((r) => r.didNotRun && r.status !== "pass" && r.status !== "skip")
    .map((r) => ({
      blocker: `${r.name} did not run`,
      owner: "developer" as const,
      reason: "scanner/check setup",
      steps: [
        r.suggestion ?? `Fix setup so this check can run: ${r.detail}.`,
        "Run `kit check --category security`.",
      ],
      respondWith: `${r.name} runs or is intentionally unavailable; no secret values pasted`,
      agentContinuesWith: "kit check --category security",
    }));
}

export function hitlBlocksForDeploy(results: DeployCheckResult[]): HitlBlock[] {
  return results
    .filter((r) => r.status === "fail")
    .map((r) => {
      if (r.didNotRun) {
        return {
          blocker: `${r.provider} deploy env check did not run for ${r.project}/${r.environment}`,
          owner: "developer" as const,
          reason: "provider CLI auth / setup",
          steps: [`Fix provider CLI setup: ${r.detail}.`, "Run `kit check --category deploy`."],
          respondWith: `${r.provider} deploy env check runs; no secret values pasted`,
          agentContinuesWith: "kit check --category deploy",
        };
      }

      const missing = r.missing ?? [];
      const buildTime = r.buildTime ?? [];
      const steps = [
        `Set these key names in ${r.provider} project ${r.project} for ${r.environment}: ${missing.join(", ")}. Use provider UI or \`kit fix\` if values are declared in [secrets.keys]. Never paste values in chat.`,
      ];
      if (buildTime.length > 0) {
        steps.push(`Redeploy after setting build-time key(s): ${buildTime.join(", ")}.`);
      }
      steps.push("Run `kit check --category deploy`.");
      return {
        blocker: `${r.project}/${r.environment} missing deploy env key name(s): ${missing.join(", ")}`,
        owner: "provider admin" as const,
        reason: "deploy config / secret / external account",
        steps,
        respondWith: `${r.project}/${r.environment} deploy env names present; no secret values pasted`,
        agentContinuesWith: "kit check --category deploy",
      };
    });
}

export function hitlBlocksFromCheckResults(input: {
  config: kitConfig;
  services: ServiceStatus[];
  secrets: SecretStatus[];
  security: SecurityCheckResult[];
  deploy?: DeployCheckResult[];
}): HitlBlock[] {
  return [
    ...input.services
      .map((s) => hitlBlockForService(s, input.config))
      .filter((b): b is HitlBlock => b !== null),
    ...hitlBlocksForSecrets(input.secrets),
    ...hitlBlocksForSecurity(input.security),
    ...hitlBlocksForDeploy(input.deploy ?? []),
  ];
}

export function formatHitlBlock(block: HitlBlock): string {
  const lines = [
    "HITL behövs",
    `Blocker: ${block.blocker}`,
    `Ägare: ${block.owner}`,
    `Varför agenten inte kan lösa: ${block.reason}`,
    "Gör detta:",
    ...block.steps.map((step, i) => `${i + 1}. ${step}`),
    `Svara med: ${block.respondWith}`,
    `Agenten fortsätter med: ${block.agentContinuesWith}`,
  ];
  return lines.join("\n");
}

export function formatHitlBlocks(blocks: HitlBlock[]): string {
  return blocks.map(formatHitlBlock).join("\n\n");
}
