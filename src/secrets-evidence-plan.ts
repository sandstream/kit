/**
 * The evidence plan `kit secrets incident` prints next to the rotation plan: for each key, the
 * command that fetches the STORE's own access record for it, plus kit's own record.
 *
 * Why: the rotation plan assumes every key was read, and correctly so, because kit had no evidence
 * that would justify less (kit-research `kms-decrypt-evidence-vs-kit`, 2026-11-27). The vault
 * services keep that evidence themselves: AWS logs every `GetSecretValue` and KMS `Decrypt` in
 * CloudTrail, GCP logs `AccessSecretVersion` as a Data Access log when those are on, Azure Key Vault
 * logs `SecretGet` as an `AuditEvent` once a diagnostic setting routes it. Pointing the person at
 * the right query per key is a deterministic mapping from the backend kit already knows.
 *
 * Rules this module keeps:
 *   - Printed, never executed. kit holds no cloud credentials here and runs nothing.
 *   - Every command was checked against the vendor's documentation (`source`). A store whose
 *     query could not be verified gets no command and is marked "not verified".
 *   - A missing event proves only that the secret was not read THROUGH THAT SERVICE: not that the
 *     value was never read (a copy in `.env.local`, a cached data key, a leaked token).
 *   - Names and identifiers only, never a value.
 */
import type { SecretKeyConfig } from "./config.js";

export interface EvidenceStep {
  /** Whose record: "AWS CloudTrail", "kit audit chain", … */
  service: string;
  /** The command or query to run yourself; null when none could be verified. */
  command: string | null;
  verified: boolean;
  /** Vendor documentation the command was checked against. */
  source?: string;
  caveats: string[];
}

export const EVIDENCE_LIMIT =
  'A missing event proves only "not read through that service", not that the value was never read.';

const DOCS = {
  lookupEvents: "https://docs.aws.amazon.com/cli/latest/reference/cloudtrail/lookup-events.html",
  smCloudTrail:
    "https://docs.aws.amazon.com/secretsmanager/latest/userguide/monitoring-cloudtrail.html",
  kmsDecrypt: "https://docs.aws.amazon.com/kms/latest/developerguide/ct-decrypt.html",
  gcpSmAudit: "https://docs.cloud.google.com/secret-manager/docs/audit-logging",
  gcpDataAccess: "https://docs.cloud.google.com/logging/docs/audit/configure-data-access",
  azureKvLogging: "https://learn.microsoft.com/en-us/azure/key-vault/general/logging",
  azureKvMonitor: "https://learn.microsoft.com/en-us/azure/key-vault/general/monitor-key-vault",
  opItemUsages: "https://www.1password.dev/events-api/reference/",
  infisicalAuditLogs: "https://infisical.com/docs/documentation/platform/audit-logs",
  infisicalAuditApi:
    "https://infisical.com/docs/api-reference/endpoints/audit-logs/export-audit-log",
  vaultAudit: "https://developer.hashicorp.com/vault/docs/audit",
  dopplerAccessLogs: "https://docs.doppler.com/docs/access-logs",
  bitwardenEvents: "https://bitwarden.com/help/event-logs/",
} as const;

const AWS_EVENT_HISTORY = [
  "CloudTrail Event history covers the last 90 days, in one Region (pass --region). Older reads are only in a trail or a CloudTrail Lake event data store.",
  "A trail can be configured to leave events out; Event history cannot.",
];

/** Single-quote for a POSIX shell. The person may still need to adapt quoting on Windows. */
function q(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function awsRegion(cfg: SecretKeyConfig): string {
  return cfg.aws_region ? ` --region ${cfg.aws_region}` : " --region <region>";
}

function awsSteps(name: string, cfg: SecretKeyConfig, since: string): EvidenceStep[] {
  const secretId = cfg.name || cfg.ref || name;
  const lookup = (attr: string, event: string) =>
    `aws cloudtrail lookup-events --lookup-attributes AttributeKey=ResourceName,AttributeValue=${q(attr)} --start-time ${since}${awsRegion(cfg)} --query ${q(`Events[?EventName=='${event}']`)}`;
  return [
    {
      service: "AWS CloudTrail (Secrets Manager GetSecretValue)",
      command: lookup(secretId, "GetSecretValue"),
      verified: true,
      source: DOCS.smCloudTrail,
      caveats: [
        ...AWS_EVENT_HISTORY,
        "Lookup takes one attribute; the --query keeps the GetSecretValue events. If the name finds nothing, try the secret's ARN.",
      ],
    },
    {
      service: "AWS CloudTrail (KMS Decrypt)",
      command: lookup("<kms-key-arn>", "Decrypt"),
      verified: true,
      source: DOCS.kmsDecrypt,
      caveats: [
        "Replace <kms-key-arn> with the KMS key that encrypts this secret.",
        "Decrypt names a principal (a role, a service), not a person, and omits the plaintext. A data key cached outside KMS decrypts without a new event.",
      ],
    },
  ];
}

function gcpSteps(name: string, cfg: SecretKeyConfig, since: string): EvidenceStep[] {
  const secret = cfg.name || cfg.ref || name;
  const project = cfg.gcp_project ?? "<project>";
  const filter = `protoPayload.methodName="google.cloud.secretmanager.v1.SecretManagerService.AccessSecretVersion" AND protoPayload.resourceName:"/secrets/${secret}/" AND timestamp>="${since}"`;
  return [
    {
      service: "GCP Cloud Audit Logs (Data Access, AccessSecretVersion)",
      command: `gcloud logging read ${q(filter)} --project ${project}`,
      verified: true,
      source: DOCS.gcpSmAudit,
      caveats: [
        `Data Access audit logs are disabled by default for all services except some BigQuery services (${DOCS.gcpDataAccess}). If they were off for Secret Manager, no read was logged.`,
      ],
    },
  ];
}

function azureSteps(name: string, cfg: SecretKeyConfig, since: string): EvidenceStep[] {
  const secret = cfg.name || cfg.ref || name;
  const kql = `AzureDiagnostics | where ResourceProvider == "MICROSOFT.KEYVAULT" | where OperationName == "SecretGet" | where TimeGenerated >= datetime(${since}) | where requestUri_s contains "/secrets/${secret}" | project TimeGenerated, CallerIPAddress, requestUri_s, ResultSignature`;
  return [
    {
      service: "Azure Key Vault AuditEvent (Log Analytics, SecretGet)",
      command: kql,
      verified: true,
      source: DOCS.azureKvMonitor,
      caveats: [
        "Run it in the vault's Log Analytics workspace (Logs).",
        `Resource logs are not collected until a diagnostic setting routes the AuditEvent category (${DOCS.azureKvLogging}). Without one, no read was logged.`,
      ],
    },
  ];
}

function onePasswordSteps(_n: string, _c: SecretKeyConfig, since: string): EvidenceStep[] {
  const body = JSON.stringify({ limit: 1000, start_time: since });
  return [
    {
      service: "1Password Events API (item usages)",
      command: `curl -X POST <events-api-base-url>/api/v2/itemusages -H 'Authorization: Bearer <events-token>' -H 'Content-Type: application/json' -d ${q(body)}`,
      verified: true,
      source: DOCS.opItemUsages,
      caveats: [
        "The bearer token needs the itemusages feature. Select the entries for this key's item.",
        "Replace <events-api-base-url> with your account's Events API URL (not verified here).",
      ],
    },
  ];
}

function infisicalSteps(_n: string, _c: SecretKeyConfig, since: string): EvidenceStep[] {
  const query = `eventType=get-secret&startDate=${since}&projectId=<project-id>&secretPath=<path>`;
  return [
    {
      service: "Infisical audit logs (get-secret)",
      command: `curl -H 'Authorization: Bearer <token>' ${q(`<infisical-url>/api/v1/organization/audit-logs?${query}`)}`,
      verified: true,
      source: DOCS.infisicalAuditApi,
      caveats: [
        `Audit logs need a Pro, Advanced or Enterprise plan; retention depends on the plan (${DOCS.infisicalAuditLogs}). get-secrets (a folder listing) also returns values.`,
      ],
    },
  ];
}

function vaultSteps(): EvidenceStep[] {
  return [
    {
      service: "HashiCorp Vault audit device",
      command: null,
      verified: false,
      source: DOCS.vaultAudit,
      caveats: [
        "Not verified: Vault documents no query command. Auditing is disabled on a new cluster; if a device was enabled, search its output for reads of this key's path.",
      ],
    },
  ];
}

function dopplerSteps(): EvidenceStep[] {
  return [
    {
      service: "Doppler access log",
      command: null,
      verified: false,
      source: DOCS.dopplerAccessLogs,
      caveats: [
        "Not verified as a command: Doppler documents no API or CLI for it. In the dashboard, the Access Log icon in the secret's row shows the actor, the access method and the first and last read; history depends on the plan.",
      ],
    },
  ];
}

function bitwardenSteps(): EvidenceStep[] {
  return [
    {
      service: "Bitwarden event logs",
      command: null,
      verified: false,
      source: DOCS.bitwardenEvents,
      caveats: [
        "Not verified as a command: the Public API /events filters are not documented. Teams and Enterprise organizations log 1107 (viewed item), 1108 (viewed password) and 1109 (viewed hidden field) in the Admin Console.",
      ],
    },
  ];
}

const STORES: Record<
  string,
  (name: string, cfg: SecretKeyConfig, since: string) => EvidenceStep[]
> = {
  "aws-sm": awsSteps,
  "gcp-sm": gcpSteps,
  "azure-kv": azureSteps,
  "1password": onePasswordSteps,
  infisical: infisicalSteps,
  vault: vaultSteps,
  doppler: dopplerSteps,
  bitwarden: bitwardenSteps,
};

/** kit's own record, from `kit audit secrets --key --since`. */
function kitStep(name: string, since: string): EvidenceStep {
  return {
    service: "kit audit chain",
    command: `kit audit secrets --key ${name} --since ${since}`,
    verified: true,
    caveats: ["Reads through kit only; processes that read .env.local directly are not visible."],
  };
}

/** The steps for one key: the store's record when it keeps one, then kit's. Pure. */
export function evidencePlan(name: string, cfg: SecretKeyConfig, since: string): EvidenceStep[] {
  const store = STORES[cfg.source];
  const local: EvidenceStep = {
    service: `${cfg.source} (no store-side record)`,
    command: null,
    verified: true,
    caveats: ["This source keeps no read record outside kit: assume it was read."],
  };
  return [...(store ? store(name, cfg, since) : [local]), kitStep(name, since)];
}
