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
  /**
   * Replacement applied by `redactSecrets`. Defaults to `"[REDACTED]"` (whole
   * match). Set this to keep diagnostic context while masking only the secret
   * sub-part, e.g. `"$1[REDACTED]@"` to redact a URL password but keep the host.
   */
  replacement?: string;
}

// EXACT non-credential env var names the `kv-secret` matcher skips (public CI /
// runtime metadata that would otherwise drown real findings). Deliberately NOT
// prefix-based: excluding whole prefixes (`GITHUB_`, `VERCEL_`, `RAILWAY_`, `FLY_`,
// `CI_`) also skipped the real tokens under them (GITHUB_TOKEN, VERCEL_TOKEN,
// RAILWAY_TOKEN, FLY_API_TOKEN, CI_JOB_TOKEN) — a leak. Only `KIT_*` stays a prefix
// (kit's own non-credential flag namespace).
const KV_SECRET_EXCLUDE = [
  "CI",
  "NEXT_RUNTIME",
  "RUNNER_OS",
  "RUNNER_ARCH",
  "RUNNER_NAME",
  "RUNNER_TEMP",
  "RUNNER_TOOL_CACHE",
  "RUNNER_WORKSPACE",
  "GITHUB_RUN_ID",
  "GITHUB_RUN_NUMBER",
  "GITHUB_RUN_ATTEMPT",
  "GITHUB_SHA",
  "GITHUB_REF",
  "GITHUB_REF_NAME",
  "GITHUB_REF_TYPE",
  "GITHUB_ACTION",
  "GITHUB_ACTOR",
  "GITHUB_WORKFLOW",
  "GITHUB_JOB",
  "GITHUB_REPOSITORY",
  "GITHUB_REPOSITORY_OWNER",
  "GITHUB_EVENT_NAME",
  "GITHUB_BASE_REF",
  "GITHUB_HEAD_REF",
  "GITHUB_SERVER_URL",
  "GITHUB_API_URL",
  "GITHUB_GRAPHQL_URL",
  "CI_JOB_NAME",
  "CI_JOB_STAGE",
  "CI_PIPELINE_ID",
  "CI_PROJECT_NAME",
  "CI_PROJECT_PATH",
  "CI_COMMIT_SHA",
  "CI_COMMIT_REF_NAME",
  "CI_SERVER_URL",
];
// `KEY=high-entropy` — a rotation value echoed back in an error message. Excludes
// only the EXACT metadata names above (+ the KIT_ flag namespace); every other
// uppercase KEY= with a 20+ base64url value is redacted, incl. provider tokens.
const KV_SECRET_RE = new RegExp(
  `(?<!_)\\b(?!(?:KIT_[A-Z0-9_]+|${KV_SECRET_EXCLUDE.join("|")})=)([A-Z][A-Z0-9_]{2,})=([A-Za-z0-9_\\-+/]{20,})`,
  "g",
);

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
  // Google / GCP service-account JSON fragments. A `"private_key"` value is ONE
  // double-quoted JSON string, so the body is a single bounded `[^"]` run ending
  // at the close quote — NOT two variable-length runs (`[^"]+ … [\s\S]+? … [^"]+`)
  // separated by a literal, which backtracks catastrophically: a ~18 KB blob of
  // near-miss `-----END ` tokens hung the old pattern for ~17 s (ReDoS / CPU DoS
  // of the scan). Bounded {1,8000} covers a 4096-bit PEM with escaped newlines.
  {
    re: /"private_key":\s*"-----BEGIN [^"]{1,8000}-----END [^"]{0,200}-----\\n"/g,
    label: "gcp-private-key",
  },
  // Raw (non-JSON) PEM private key block — `id_rsa`, a leaked `.pem`, or a key pasted
  // into a config/env. The JSON form above only catches an escaped-newline value inside
  // a `"private_key"` field; a bare armored block slipped through entirely. The body is a
  // single bounded lazy run between the BEGIN/END markers — no ambiguous alternation — so
  // it can't catastrophically backtrack. {1,8000} covers a 4096-bit key.
  {
    re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]{1,8000}?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/g,
    label: "pem-private-key",
  },
  { re: /\bAIza[0-9A-Za-z\-_]{35}\b/g, label: "google-api-key" },
  // Slack
  { re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, label: "slack-token" },
  // Generic JWT (3 dot-separated base64url segments)
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, label: "jwt" },
  // Supabase service-role JWT pattern (anon/service keys are JWTs; caught above)
  // OpenAI / Anthropic API keys. `svcacct-`/`admin-` have an internal hyphen
  // that breaks the bare `sk-[alnum]{40,}` run below, so list the prefixes.
  { re: /\bsk-(proj|ant|svcacct|admin)-[A-Za-z0-9_-]{20,}/g, label: "ai-api-key" },
  { re: /\bsk-[A-Za-z0-9]{40,}/g, label: "openai-key" },
  // Resend
  { re: /\bre_[A-Za-z0-9_]{20,}/g, label: "resend-key" },
  // Azure storage connection string — the `AccountKey=<base64>` component is the
  // credential; the rest (AccountName, EndpointSuffix) is not. Azure keys are 88-char
  // base64 ending in `==`; match 40+ base64 chars to be safe.
  { re: /\bAccountKey=[A-Za-z0-9+/]{40,}={0,2}/gi, label: "azure-account-key" },
  // SendGrid API key — `SG.<22 base64url>.<43 base64url>`.
  { re: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g, label: "sendgrid-key" },
  // Slack app-level token (`xapp-`) — the `xox[abprs]-` matcher above doesn't cover it.
  { re: /\bxapp-[A-Za-z0-9-]{10,}/g, label: "slack-app-token" },
  // npm automation/publish token — `npm_` + 36 base62 chars (distinct from the
  // `npm_config_*` env prefix, whose underscore breaks this run).
  { re: /\bnpm_[A-Za-z0-9]{36}\b/g, label: "npm-token" },
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
    re: KV_SECRET_RE,
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
  // Credentials embedded in a connection-string URL, e.g.
  // `postgres://user:supersecret@host/db`, `redis://:pw@host`, `mongodb+srv://…`.
  // The `kv-secret` class stops at the `:`/`@`, so these slipped through. Redact
  // ONLY the password and keep the scheme/user/host as diagnostic context.
  {
    // Scheme bounded to {0,15} (real URI schemes are ≤~11 chars): an unbounded `[a-z0-9+.-]*`
    // rescanned a long hyphen/dot run from every start looking for `://`, giving O(n²)
    // backtracking on hostile input (a DoS on the scanner / status redaction hot path). The
    // userinfo/password runs are capped too so no single segment can drive quadratic cost.
    re: /\b([a-z][a-z0-9+.-]{0,15}:\/\/[^\s:@/]{0,128}:)[^\s@/]{3,256}@/gi,
    label: "url-credentials",
    replacement: "$1[REDACTED]@",
  },
  // Token in the URL userinfo with NO colon — `https://<token>@host` — the common git /
  // registry / webhook form (`https://ghp_xxx@github.com`, `https://<pat>@dev.azure.com`).
  // The `user:pw@` matcher above stops at the `:`; this one requires a colon-free 16+ char
  // userinfo (a real username is short and wouldn't be a secret) and keeps the scheme.
  {
    re: /\b([a-z][a-z0-9+.-]{0,15}:\/\/)[A-Za-z0-9._~%+-]{16,256}@/gi,
    label: "url-token-userinfo",
    replacement: "$1[REDACTED]@",
  },
  // Generic high-entropy hex tokens (32+ hex chars) — last resort
  // Skipped intentionally: too many false-positives against commit hashes.
];

/**
 * How many credential shapes kit itself can recognise.
 *
 * Derived from the list, never written down: a hardcoded count is a claim that rots the first time
 * someone adds a pattern. This number exists so a scanner that finds nothing can say what it looked
 * for — "no secrets found" and "no secrets of the 29 kinds I know" are different statements, and
 * only the second one is true. Some tables must be hardcoded (nothing in a repo can tell you what a
 * Stripe key looks like); what must never be hidden is where the table ends.
 */
export const SECRET_SHAPE_COUNT = SECRET_PATTERNS.length;

/** The shape labels, for a caller that wants to name them rather than count them. */
export function secretShapeLabels(): string[] {
  return [...new Set(SECRET_PATTERNS.map((p) => p.label))].sort();
}

export function redactSecrets(input: string): string {
  if (!input) return input;
  let out = input;
  for (const { re, replacement } of SECRET_PATTERNS) {
    out = out.replace(re, replacement ?? "[REDACTED]");
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

/** Shannon entropy in bits/char of a string. Pure. */
export function shannonEntropy(s: string): number {
  if (!s) return 0;
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

// The `kv-secret` pattern deliberately allowlists runtime env prefixes
// (KIT_/GITHUB_/CI_/…) to avoid false positives on CI metadata. That's right for
// scanning code/diffs, but it leaves a hole in the FAIL-CLOSED shared-memory gate:
// a real high-entropy credential stored under such a prefix slips through. The
// entropy backstop closes it WITHOUT widening the noisy code-scan path: when
// enabled (the `kit memory share` write gate), an ALL-CAPS `KEY=value` whose value
// is long + genuinely high-entropy is flagged regardless of prefix. The 4.2
// bits/char threshold catches base64/base62 secrets while clearing hex hashes
// (~4.0) and dictionary-ish values like `development`/`production_mode`.
const ENTROPY_KV = /\b([A-Z][A-Z0-9_]{2,})\s*[:=]\s*["']?([A-Za-z0-9_\-+/.]{24,})/g;
const ENTROPY_MIN_BITS = 4.2;

function findEntropyKvSecrets(text: string): SecretFinding[] {
  const out: SecretFinding[] = [];
  for (const m of text.matchAll(ENTROPY_KV)) {
    const value = m[2];
    if (shannonEntropy(value) < ENTROPY_MIN_BITS) continue;
    out.push({ label: "high-entropy-kv", preview: `${value.slice(0, 6)}…${value.slice(-4)}` });
  }
  return out;
}

// PII parity (from the ruvnet/AIDefence research): kit's patterns are secret-focused
// and detect no PII. A Swedish personnummer is the highest-value, most-relevant PII to
// catch at rest in the memory store — and it is high-PRECISION because it carries a Luhn
// check digit, so we validate rather than match a bare 10/12-digit run (which would flag
// every timestamp/id). Detection only (masked), never echoed. Samordningsnummer (day+60)
// is intentionally out of scope to keep false positives low.
const PERSONNUMMER_RE = /\b(\d{6}|\d{8})[-+]?(\d{4})\b/g;

/** Luhn checksum over a 10-digit personnummer core (weights 2,1,… over the first 9).
 *  Uses charCodeAt digit math (not Number()) so each char is a plain 0–9 with no NaN
 *  path — the input is always a `\d{10}` capture from PERSONNUMMER_RE. */
function personnummerLuhnValid(core10: string): boolean {
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    let digit = (core10.charCodeAt(i) - 48) * (i % 2 === 0 ? 2 : 1);
    if (digit > 9) digit -= 9;
    sum += digit;
  }
  return (10 - (sum % 10)) % 10 === core10.charCodeAt(9) - 48;
}

function findSwedishPersonnummer(text: string): SecretFinding[] {
  const out: SecretFinding[] = [];
  for (const m of text.matchAll(PERSONNUMMER_RE)) {
    const datePart = m[1];
    const last4 = m[2];
    const core10 = (datePart.length === 8 ? datePart.slice(2) : datePart) + last4; // YYMMDD+NNNN
    const mm = Number(core10.slice(2, 4));
    const dd = Number(core10.slice(4, 6));
    // isFinite guard is defensive (the slices are always digits) and keeps the date
    // check off the NaN<cutoff fail-open path.
    if (!Number.isFinite(mm) || !Number.isFinite(dd)) continue;
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31) continue; // not a plausible date → skip
    if (!personnummerLuhnValid(core10)) continue; // fails the check digit → not a personnummer
    out.push({
      label: "swedish-personnummer",
      preview: `${core10.slice(0, 4)}…${core10.slice(-2)}`,
    });
  }
  return out;
}

export function findSecrets(
  text: string,
  opts: { entropyBackstop?: boolean } = {},
): SecretFinding[] {
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
  findings.push(...findSwedishPersonnummer(text)); // PII-at-rest (Luhn-validated)
  if (opts.entropyBackstop) findings.push(...findEntropyKvSecrets(text));
  return findings;
}
