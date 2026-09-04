import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  monkeyFinding,
  prioritizeFindings,
  type MonkeyFinding,
  type MonkeyPackageJson,
} from "./monkey-test-contract.js";
import {
  allMonkeyDependencies,
  detectPaymentProviders,
  firstMonkeyFileMatching,
  hasAnyMonkeyFile,
  readMonkeyJson,
  scanMonkeySources,
  withoutMonkeySourceComments,
  type MonkeySourceScan,
} from "./monkey-test-scan.js";
import { findSecrets } from "./utils/redactSecrets.js";

interface SecurityContext {
  scan: MonkeySourceScan;
  deps: Record<string, string>;
  controlFiles: Record<string, string>;
  controlText: string;
  providers: string[];
  usesSupabase: boolean;
}

const SUPABASE_RLS_PATTERNS = [
  new RegExp("alter\\s+table[\\s\\S]{0,160}enable\\s+row\\s+level\\s+security", "i"),
];
const SUPABASE_POLICY_PATTERNS = [
  new RegExp(
    "create\\s+policy[\\s\\S]{0,240}\\bon\\b[\\s\\S]{0,240}\\b(?:using|with\\s+check)\\b",
    "i",
  ),
];
const SUPABASE_CONTROL_FILE_PATTERN = new RegExp("supabase|create\\s+table|from\\(['\"]", "i");
const SUPABASE_RPC_PATTERNS = [
  new RegExp("create\\s+(or\\s+replace\\s+)?function|\\brpc\\s*\\(", "i"),
];
const SUPABASE_RPC_AUTHZ_PATTERNS = [
  new RegExp(
    "create\\s+(or\\s+replace\\s+)?function[\\s\\S]{0,1200}(?:auth\\.uid\\(\\)|current_setting\\(['\"]request\\.jwt|security\\s+invoker)",
    "i",
  ),
];
const SUPABASE_RPC_FILE_PATTERN = new RegExp(
  "create\\s+(or\\s+replace\\s+)?function|\\brpc\\(",
  "i",
);
const PUBLIC_BUCKET_PATTERN = new RegExp("public\\s*[:=]\\s*true|createBucket\\([^)]*public", "i");

async function securityContext(cwd: string): Promise<SecurityContext> {
  const pkg = await readMonkeyJson<MonkeyPackageJson>(join(cwd, "package.json"));
  const deps = allMonkeyDependencies(pkg);
  const scan = await scanMonkeySources(cwd);
  const controlFiles = withoutMonkeySourceComments(scan.runtimeFiles);
  const providers = detectPaymentProviders(deps, scan.runtimeText);
  return {
    scan,
    deps,
    controlFiles,
    controlText: Object.values(controlFiles).join("\n"),
    providers,
    usesSupabase:
      "supabase" in deps ||
      "@supabase/supabase-js" in deps ||
      existsSync(join(cwd, "supabase", "config.toml")) ||
      /supabase/i.test(scan.runtimeText),
  };
}

function committedSecretFindings(scan: MonkeySourceScan): MonkeyFinding[] {
  const findings: MonkeyFinding[] = [];
  const liveSecretFile = firstMonkeyFileMatching(
    scan.runtimeFiles,
    /\b(?:sk|pk|rk)_live_[A-Za-z0-9]{16,}/,
  );
  if (liveSecretFile) {
    findings.push(
      monkeyFinding({
        severity: "critical",
        area: "security",
        title: "Committed live payment key pattern",
        file: liveSecretFile,
        repro: `rg "(sk|pk|rk)_live_" ${liveSecretFile}`,
        fix: "Remove the live key, rotate it at the provider, and keep only placeholders in committed files.",
      }),
    );
  }

  for (const [file, text] of Object.entries(scan.runtimeFiles)) {
    const labels = [
      ...new Set(
        findSecrets(text)
          .map((hit) => hit.label)
          .filter((label) => label !== "stripe-key"),
      ),
    ];
    if (labels.length === 0) continue;
    findings.push(
      monkeyFinding({
        severity: "critical",
        area: "security",
        title: "Secret-shaped value in runtime source",
        file,
        repro: `kit security scan-artifact ${file} (${labels.join(", ")})`,
        fix: "Remove and rotate the credential, then resolve it from the configured vault at runtime.",
      }),
    );
  }
  return findings;
}

function livePaymentEnvironmentFindings(): MonkeyFinding[] {
  const findings: MonkeyFinding[] = [];
  for (const [key, value] of Object.entries(process.env)) {
    if (!/STRIPE|PAYMENT|CONNECT/i.test(key)) continue;
    if (!/^(sk|pk|rk)_live_/.test(value ?? "")) continue;
    findings.push(
      monkeyFinding({
        severity: "critical",
        area: "money",
        title: `Live payment credential in runtime env (${key})`,
        repro: `env | rg "^${key}="`,
        fix: "Run monkey-test with sandbox/test credentials only; never drive release gates against live payment rails.",
      }),
    );
  }
  return findings;
}

function rlsPolicyFindings(context: SecurityContext): MonkeyFinding[] {
  const hasRls = hasAnyMonkeyFile(context.controlFiles, SUPABASE_RLS_PATTERNS);
  const hasPolicy = hasAnyMonkeyFile(context.controlFiles, SUPABASE_POLICY_PATTERNS);
  if (hasRls && hasPolicy) return [];
  return [
    monkeyFinding({
      severity: "high",
      area: "authz",
      title: "Supabase detected without obvious RLS policy coverage",
      file: firstMonkeyFileMatching(context.controlFiles, SUPABASE_CONTROL_FILE_PATTERN),
      repro: 'rg -n "enable row level security|create policy|auth.uid" supabase src',
      fix: "Add RLS policies for tenant/customer/staff/owner/support paths and cover them with role-based tests.",
    }),
  ];
}

function rpcAuthorizationFindings(context: SecurityContext): MonkeyFinding[] {
  const hasRpc = hasAnyMonkeyFile(context.controlFiles, SUPABASE_RPC_PATTERNS);
  const rpcAuthz = hasAnyMonkeyFile(context.controlFiles, SUPABASE_RPC_AUTHZ_PATTERNS);
  if (!hasRpc || rpcAuthz) return [];
  return [
    monkeyFinding({
      severity: "high",
      area: "authz",
      title: "RPC/function path lacks obvious caller authorization",
      file: firstMonkeyFileMatching(context.controlFiles, SUPABASE_RPC_FILE_PATTERN),
      repro: 'rg -n "create function|rpc\\(" supabase src',
      fix: "Assert caller identity and tenant scope inside every RPC, then add cross-role denial tests.",
    }),
  ];
}

function publicBucketFindings(context: SecurityContext): MonkeyFinding[] {
  const publicBucket = firstMonkeyFileMatching(context.controlFiles, PUBLIC_BUCKET_PATTERN);
  if (!publicBucket) return [];
  return [
    monkeyFinding({
      severity: "high",
      area: "security",
      title: "Public storage bucket declaration",
      file: publicBucket,
      repro: `rg -n "public.*true|createBucket" ${publicBucket}`,
      fix: "Default buckets to private; expose signed URLs or explicit public assets only.",
    }),
  ];
}

function supabaseFindings(context: SecurityContext): MonkeyFinding[] {
  if (!context.usesSupabase) return [];
  return [
    ...rlsPolicyFindings(context),
    ...rpcAuthorizationFindings(context),
    ...publicBucketFindings(context),
  ];
}

function tenantIsolationFindings(context: SecurityContext): MonkeyFinding[] {
  if (context.providers.length === 0) return [];
  const tenantFields =
    "(?:tenant_id|organization_id|organisation_id|org_id|account_id|workspace_id)";
  const hasTenantIsolation = hasAnyMonkeyFile(context.controlFiles, [
    new RegExp(`\\b${tenantFields}\\b\\s+(?:uuid|text|varchar|integer|bigint|references)`, "i"),
    new RegExp(`\\.(?:eq|filter|where|match)\\s*\\(\\s*["']${tenantFields}["']`, "i"),
    new RegExp(`\\bwhere\\b[^;\\n]{0,160}\\b${tenantFields}\\b`, "i"),
    new RegExp(
      `\\b${tenantFields}\\b\\s*[:=]\\s*(?:auth|session|user|request|context|ctx|claims)\\b`,
      "i",
    ),
  ]);
  if (hasTenantIsolation) return [];
  return [
    monkeyFinding({
      severity: "high",
      area: "authz",
      title: "Money app lacks obvious tenant/org isolation markers",
      repro: 'rg -n "tenant_id|organization_id|org_id|account_id|workspace_id" src db supabase',
      fix: "Thread tenant identity through auth, queries, mutations, payment objects, and webhook handlers.",
    }),
  ];
}

function webhookFindings(controlFiles: Record<string, string>): MonkeyFinding[] {
  const findings: MonkeyFinding[] = [];
  const webhookSignature = hasAnyMonkeyFile(controlFiles, [
    /(?:webhooks?\.)?constructEvent\s*\(/i,
    /(?:verify|validate)\w*Webhook\w*Signature\s*\(/i,
    /(?:svix|webhook)[\s\S]{0,120}\.verify\s*\(/i,
    /(?:hmac|signature)[\s\S]{0,120}(?:timingSafeEqual|verify)\s*\(/i,
  ]);
  if (!webhookSignature) {
    findings.push(
      monkeyFinding({
        severity: "critical",
        area: "money",
        title: "Payment provider detected without webhook signature verification",
        repro:
          'rg -n "constructEvent|webhook.*signature|STRIPE_WEBHOOK_SECRET|svix" src app pages api',
        fix: "Verify every webhook with the provider signature before parsing or mutating state.",
      }),
    );
  }
  const idempotency = hasAnyMonkeyFile(controlFiles, [
    /(?:insert|upsert|create|set)\s*\([\s\S]{0,240}\b(?:event\.id|event_id|provider_event_id|idempotency_key)\b/i,
    /\b(?:event_id|provider_event_id|idempotency_key)\b[\s\S]{0,120}\b(?:unique|primary\s+key)\b/i,
    /\bon\s+conflict\b[^;\n]{0,160}\b(?:event_id|provider_event_id|idempotency_key)\b/i,
  ]);
  if (!idempotency) {
    findings.push(
      monkeyFinding({
        severity: "high",
        area: "money",
        title: "Payment webhook path lacks obvious idempotency ledger",
        repro: 'rg -n "idempotenc|event.id|webhook_events|processed_events|dedupe" src db supabase',
        fix: "Persist provider event IDs and make webhook side effects idempotent before release.",
      }),
    );
  }
  return findings;
}

function moneyLifecycleFindings(controlFiles: Record<string, string>): MonkeyFinding[] {
  const findings: MonkeyFinding[] = [];
  const refundPath = hasAnyMonkeyFile(controlFiles, [
    /\brefunds?\.(?:create|issue|request|cancel)\s*\(/i,
    /\b(?:create|issue|process|request|authorize)Refund\s*\(/,
    /\b(?:app|router|route)\.(?:post|put|patch|delete)\s*\([^\n)]*refund/i,
  ]);
  if (!refundPath) {
    findings.push(
      monkeyFinding({
        severity: "medium",
        area: "money",
        title: "Refund path not found",
        repro: 'rg -n "refund" src app pages api db supabase',
        fix: "Add a tested refund/cancel path with authorization, receipt update, and immutable journal entry.",
      }),
    );
  }
  const receiptPath = hasAnyMonkeyFile(controlFiles, [
    /\breceipts?\.(?:create|insert|upsert|send)\s*\(/i,
    /\b(?:create|generate|issue|send)Receipt\s*\(/,
    /\breceipt_url\b/i,
  ]);
  if (!receiptPath) {
    findings.push(
      monkeyFinding({
        severity: "medium",
        area: "money",
        title: "Receipt path not found",
        repro: 'rg -n "receipt" src app pages api db supabase',
        fix: "Generate customer-visible receipts from settled test-mode payment state.",
      }),
    );
  }
  const journalAppend = hasAnyMonkeyFile(controlFiles, [
    /\b(?:ledger|journal|payment_events?|money_events?)\b[\s\S]{0,160}\.(?:insert|append|create)\s*\(/i,
    /\b(?:insert|append|create)\s*\([\s\S]{0,160}\b(?:ledger|journal|payment_events?|money_events?)\b/i,
  ]);
  const journalMutationBlocked = hasAnyMonkeyFile(controlFiles, [
    /\brevoke\s+(?:update|delete)[\s\S]{0,160}\b(?:ledger|journal|payment_events?|money_events?)\b/i,
    /\bbefore\s+(?:update|delete)[\s\S]{0,240}\b(?:raise|reject|prevent)\b/i,
  ]);
  if (!journalAppend || !journalMutationBlocked) {
    findings.push(
      monkeyFinding({
        severity: "high",
        area: "money",
        title: "Immutable money journal not found",
        repro: 'rg -n "ledger|journal|append|immutable" src app pages api db supabase',
        fix: "Record append-only payment/refund/journal events and forbid destructive edits.",
      }),
    );
  }
  return findings;
}

function paymentProviderFindings(context: SecurityContext): MonkeyFinding[] {
  if (context.providers.length === 0) return [];
  return [
    ...webhookFindings(context.controlFiles),
    ...moneyLifecycleFindings(context.controlFiles),
  ];
}

function headerPolicyFindings(context: SecurityContext): MonkeyFinding[] {
  const webApp = /next|remix|svelte|astro|react|vue|express/i.test(
    Object.keys(context.deps).join("\n"),
  );
  if (
    !webApp ||
    /Content-Security-Policy|contentSecurityPolicy|headers\s*\(/i.test(context.controlText)
  ) {
    return [];
  }
  return [
    monkeyFinding({
      severity: "medium",
      area: "security",
      title: "CSP/header policy not found",
      repro: 'rg -n "Content-Security-Policy|contentSecurityPolicy|headers\\(" .',
      fix: "Add CSP and security headers for app and payment routes; include the sandbox payment domains needed by tests.",
    }),
  ];
}

export async function securityFindings(cwd: string): Promise<MonkeyFinding[]> {
  const context = await securityContext(cwd);
  return prioritizeFindings([
    ...committedSecretFindings(context.scan),
    ...livePaymentEnvironmentFindings(),
    ...supabaseFindings(context),
    ...tenantIsolationFindings(context),
    ...paymentProviderFindings(context),
    ...headerPolicyFindings(context),
  ]);
}
