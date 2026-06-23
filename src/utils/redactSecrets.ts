/**
 * Redacts well-known secret patterns from text before it's stored or logged.
 *
 * CLI commands like `stripe config --list` happily print API keys to stdout.
 * We need to surface auth status without persisting the credential itself —
 * once it lands in ServiceStatus.output it can leak via audit logs,
 * escalation messages, or `--json` dumps.
 *
 * Patterns are intentionally over-eager: better a false-positive redaction
 * than a real secret in a log file.
 */

interface RedactPattern {
  re: RegExp;
  /** Optional label for the redaction (e.g. "stripe-key") for debugging. */
  label: string;
}

export const SECRET_PATTERNS: RedactPattern[] = [
  // Stripe — sk_test_, sk_live_, pk_test_, pk_live_, rk_test_, rk_live_,
  // whsec_, sk_test_..., 24+ random chars
  { re: /\b(sk|pk|rk)_(test|live)_[A-Za-z0-9]{20,}/g, label: "stripe-key" },
  { re: /\bwhsec_[A-Za-z0-9]{20,}/g, label: "stripe-webhook-secret" },
  // GitHub PATs and tokens
  { re: /\bghp_[A-Za-z0-9]{30,}/g, label: "github-classic-pat" },
  { re: /\bgho_[A-Za-z0-9]{30,}/g, label: "github-oauth" },
  { re: /\b(ghs|ghu|ghr)_[A-Za-z0-9]{30,}/g, label: "github-server-token" },
  { re: /\bgithub_pat_[A-Za-z0-9_]{60,}/g, label: "github-fine-pat" },
  // AWS — AKIA + 16 uppercase, ASIA + 16 (STS), and 40-char secret keys
  { re: /\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, label: "aws-access-key" },
  { re: /aws_secret_access_key\s*=\s*[A-Za-z0-9/+]{40}/gi, label: "aws-secret-key" },
  // Google / GCP service-account JSON fragments
  {
    re: /"private_key":\s*"-----BEGIN [^"]+-----[\s\S]+?-----END [^"]+-----\\n"/g,
    label: "gcp-private-key",
  },
  { re: /\bAIza[0-9A-Za-z\-_]{35}\b/g, label: "google-api-key" },
  // Slack
  { re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, label: "slack-token" },
  // Generic JWT (3 dot-separated base64url segments)
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, label: "jwt" },
  // Supabase service-role JWT pattern (anon/service keys are JWTs; caught above)
  // OpenAI / Anthropic API keys
  { re: /\bsk-(proj-|ant-)[A-Za-z0-9_-]{30,}/g, label: "ai-api-key" },
  { re: /\bsk-[A-Za-z0-9]{40,}/g, label: "openai-key" },
  // Resend
  { re: /\bre_[A-Za-z0-9_]{20,}/g, label: "resend-key" },
  // Generic `KEY=high-entropy` — catches rotation values that get echoed
  // back inside `op item create ... KEY=<value>` style error messages.
  // Only triggers on uppercase-snake-case identifiers followed by `=`
  // and a 20+ char base64url-ish blob, to avoid clobbering normal config.
  //
  // Negative lookahead excludes well-known non-credential env vars whose
  // values are public identifiers or status strings (UUIDs, task statuses,
  // wake reasons). These show up constantly in agent transcripts and would
  // otherwise drown real credential findings.
  //
  // KIT_* — kit's own env vars (flags, policy hash) are runtime-injected, never
  //               are credentials.
  // GITHUB_RUN_ID / GITHUB_SHA — CI metadata.
  {
    re: /(?<!_)\b(?!(?:KIT|GITHUB|CI|RUNNER|VERCEL|RAILWAY|FLY|NEXT_RUNTIME)_)([A-Z][A-Z0-9_]{2,})=([A-Za-z0-9_\-+/]{20,})/g,
    label: "kv-secret",
  },
  // Terraform — `sensitive = "..."` blocks in HCL leak the literal value
  // unless the operator uses a vault-backed datasource. Catches both the
  // unquoted and quoted forms.
  {
    re: /\bsensitive\s*=\s*"([^"\\]{20,}|[^"\\]*(?:\\.[^"\\]*)*)"/g,
    label: "terraform-sensitive",
  },
  // Terraform state JSON — `.tfstate` files store resolved values, including
  // database passwords and API tokens that originated from -var or env vars.
  // Matches `"sensitive_value": "..."` and the more common `"value": "..."`
  // entries that show up under `outputs.<name>.value`.
  {
    re: /"(sensitive_value|value)"\s*:\s*"([A-Za-z0-9_\-+/]{20,})"/g,
    label: "tfstate-value",
  },
  // Generic high-entropy hex tokens (32+ hex chars) — last resort
  // Skipped intentionally: too many false-positives against commit hashes.
];

export function redactSecrets(input: string): string {
  if (!input) return input;
  let out = input;
  for (const { re } of SECRET_PATTERNS) {
    out = out.replace(re, "[REDACTED]");
  }
  return out;
}

/**
 * Reduce a command's (possibly multi-line, secret-bearing) output to a single
 * line safe to show as an auth-status detail. Redacts known credentials, then
 * takes the first non-empty line and caps its length. Belt-and-suspenders:
 * callers such as `checkServices` already redact at the source, but a verbose
 * `stripe config --list` dump still spans many lines of account metadata, and
 * not every producer redacts (e.g. login.ts's post-login verify). This makes a
 * single redacted line the only thing that can reach a status table or
 * `--json` detail.
 */
export function safeStatusLine(output: string, max = 80): string {
  const line =
    redactSecrets(output || "")
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  return line.slice(0, max);
}

export interface SecretFinding {
  label: string;
  preview: string;
}

/**
 * Scans `text` for the same SECRET_PATTERNS used by redactSecrets and
 * returns per-match labels + a short masked preview. Useful for warning
 * the user about plaintext credentials in `.env` files at init time
 * without echoing the secret itself.
 */
/**
 * Known-public JWT issuers that show up in dev environments and aren't
 * credential leaks. `supabase-demo` is the issuer used by every `supabase
 * start` local stack — the anon + service-role keys are public, identical
 * across every developer's machine, and rotating them does nothing.
 *
 * If a JWT decodes with one of these issuers, we drop it from findings.
 */
const PUBLIC_JWT_ISSUERS = new Set(["supabase-demo"]);

function isPublicDemoJwt(jwt: string): boolean {
  try {
    const parts = jwt.split(".");
    if (parts.length !== 3) return false;
    // base64url → base64 → decode
    const payloadB64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payloadB64 + "=".repeat((4 - (payloadB64.length % 4)) % 4);
    const payload = Buffer.from(padded, "base64").toString("utf-8");
    const parsed = JSON.parse(payload) as { iss?: string };
    return !!parsed.iss && PUBLIC_JWT_ISSUERS.has(parsed.iss);
  } catch {
    return false;
  }
}

export function findSecrets(text: string): SecretFinding[] {
  if (!text) return [];
  const findings: SecretFinding[] = [];
  for (const { re, label } of SECRET_PATTERNS) {
    const matches = text.matchAll(new RegExp(re.source, re.flags));
    for (const m of matches) {
      const raw = m[0];
      // Skip well-known public demo JWTs (e.g. `supabase start` anon key).
      if (label === "jwt" && isPublicDemoJwt(raw)) continue;
      const head = raw.slice(0, 6);
      const tail = raw.length > 12 ? raw.slice(-4) : "";
      findings.push({
        label,
        preview: tail ? `${head}…${tail}` : `${head}…`,
      });
    }
  }
  return findings;
}
