# kit ↔ OWASP Top 10 (2025)

> OWASP Top 10 2025 — how kit's shipped controls map to each category.
> Re-validated 2026-06-08.

Per memory `feedback_owasp_2025`, security reviews target the **2025** Top 10
(not 2021): A03 = supply-chain compromise (new), A10 = exceptional conditions
(new). kit's security posture is graded below.

## A01 — Broken Access Control

| kit control | Status |
|---|---|
| Read-only mode (`--read-only` / `KIT_READ_ONLY=1`) refuses every mutation | ✅ shipped (T.2) |
| Elevation-gate on destructive ops (`requireElevation` / `consumeElevation`) | ✅ shipped |
| Per-op scope mapping with one-shot consumption for irreversible ops | ✅ shipped (P2.5 `elevation-scopes.ts`) |
| `[policy.agent_writes]` pre-approval + `KIT_POLICY_HASH` for classifier consumption | ✅ shipped (P1.3 `policy.ts`) |
| RBAC model + decision-path tests | ✅ shipped (`rbac-model.ts` + `rbac-service.test.ts`) |

## A02 — Cryptographic Failures

| kit control | Status |
|---|---|
| Token store `~/.kit/mcp-tokens.json` atomic write + mode 0o600 on create | ✅ fixed (security-review caught race window — `edb29f7`) |
| Parent dir `~/.kit/` chmod 0o700 | ✅ shipped |
| Secret values never echoed in error messages (`safeText()` truncation + redactSecrets) | ✅ shipped |
| TOTP secret at `~/.kit/totp-secret` chmod 0o600 | ✅ shipped (`elevation.ts:enrollTotp`) |
| Tokens never persisted in plugin code — read from vault per-call | ✅ shipped (every sandstream-kit-plugin-* follows this pattern) |
| TLS: every fetch uses HTTPS to vendor APIs; no custom `Agent` with `rejectUnauthorized:false` | ✅ verified in P0 audit |

## A03 — Software & Data Supply Chain Failures (NEW in 2025)

| kit control | Status |
|---|---|
| Bumblebee supply-chain scanner integrated (PR #2, PR #17, PR #20) | ✅ shipped |
| `kit triage npm <pkg> --sandbox` — pre-install offline tarball inspection | ✅ shipped |
| Pre-commit triage gate (`kit triage check-deps`) refuses commits adding untriaged deps | ✅ shipped (P1.6) |
| npm publish `--provenance` (SLSA Level 3 attestation) | ✅ shipped |
| GitHub artifact attestation cross-verification | ✅ shipped (`actions/attest-build-provenance` in publish.yml) |
| CycloneDX + SPDX SBOM published per release | ✅ shipped |
| GPG-signed tags required by publish.yml | ✅ shipped (T.5) |
| `sandstream-kit-plugin-snyk` + `sandstream-kit-plugin-wiz` — read-only scanner-result ingestion | ✅ shipped (T.6) |
| `docs/VERIFY.md` documents the operator-side verification flow | ✅ shipped |

## A04 — Insecure Design

| kit control | Status |
|---|---|
| Trust model + data-flow are explicit docs (`THREAT_MODEL.md`, `DATA_FLOW.md`) | ✅ shipped (T.1) |
| `[policy.agent_writes]` makes agent-permitted scopes EXPLICIT, not implicit | ✅ shipped (P1.3) |
| Bypass detection: pre-commit sentinel + post-commit detector log `--no-verify` skips | ✅ shipped (P0.4) |
| Audit-log fail-closed — every destructive op leaves a forensic trail or refuses | ✅ shipped |

## A05 — Security Misconfiguration

| kit control | Status |
|---|---|
| `kit check` validates `.kit.toml`, lockfiles, hooks, gitignore, secret refs | ✅ shipped |
| `kit fix` auto-remediates 6 common gaps (tools, locks, services, .env.template, gitignore, hooks) | ✅ shipped (P0.3) |
| `kit security check-gitignore [--fix]` — `.env*`, `*.pem`, `.kit/elevation.json` patterns | ✅ shipped |
| `templates/iam/<vendor>.json` — minimal-scope IAM/PAT templates per integration | ✅ shipped (T.3) |
| Read-only mode is a session-wide default operators can enforce | ✅ shipped |
| Audit-log default = local only (Remote push is opt-in `[governance.audit].remote = true`) | ✅ shipped (T.4) |

## A06 — Vulnerable and Outdated Components

| kit control | Status |
|---|---|
| `npm audit --audit-level=high` enforced in publish.yml | ✅ shipped |
| Dependabot for SHA-pinned actions in `.github/workflows/*` | ✅ shipped |
| Bumblebee deep-scan in CI | ✅ shipped |
| `kit security policy` validates dep allowlist | ✅ shipped |
| Quarterly OpenSSF Scorecard run | ✅ shipped (`.github/workflows/scorecard.yml`) |

## A07 — Identification & Authentication Failures

| kit control | Status |
|---|---|
| TOTP enrollment + verification on elevation | ✅ shipped (RFC 6238 inline impl) |
| 15-minute default elevation TTL; one-shot scopes for jwt-secret-roll / purge-history / onecli-register | ✅ shipped |
| `KIT_ELEVATED=1` CI escape hatch emits loud stderr warning + audit event | ✅ shipped |
| `KIT_PROD_OK=1` warning at the read site (not the consumer site) | ✅ shipped (P0.2) |
| `KIT_NON_INTERACTIVE=1` emits one-time stderr warning + audit | ✅ shipped (P1.8) |
| MCP token store separate from raw vault — short-lived bearer not long-term refresh | ✅ shipped (P1.2) |

## A08 — Software & Data Integrity Failures

| kit control | Status |
|---|---|
| SLSA provenance on every release | ✅ shipped |
| Signed git tags required to publish | ✅ shipped (T.5) |
| Pre-commit hook sentinel + post-commit detector log `--no-verify` skips | ✅ shipped (P0.4) |
| `kit security verify-pull` post-merge audit: new deps, gitignore drops, introduced secrets | ✅ shipped |
| Audit-log atomic write (tmp + rename) prevents half-written entries | ✅ shipped |
| Vercel `upsertEnvVar` atomic (PATCH fast-path; create-then-delete fallback) | ✅ shipped (P2.4 earlier) |

## A09 — Security Logging & Monitoring Failures

| kit control | Status |
|---|---|
| `.kit-audit.jsonl` append-only; every destructive op logged | ✅ shipped |
| `.kit-skipped-commits.jsonl` records `git commit --no-verify` events | ✅ shipped |
| `.kit-scan-results.jsonl` consolidates Bumblebee + Snyk + Wiz findings | ✅ shipped (T.6) |
| `appendAuditEventDirect` fail-closed (caller refuses if audit-log write fails) | ✅ shipped |
| `[governance.audit].remote = true` opt-in for centralized log shipping with retry-queue | ✅ shipped |
| Sentry integration (`sandstream-kit-plugin-sentry`) for issue triage + release tagging | ✅ shipped (P1.1) |
| Cost-monitor anomaly detection with rolling baseline (EMA) | ✅ shipped (P3.1) |

## A10 — Exceptional Conditions (NEW in 2025)

This is the newly-added category — error-handling, fallback behavior, race
conditions, and degraded-mode operation. kit's audit found multiple
fail-open paths in pre-2026-06 versions; all are now fail-closed:

| Pre-2026-06 (BAD) | Post-2026-06 (FIXED) | Status |
|---|---|---|
| Rate-limiter failed OPEN on Redis error | Fail-closed; opt-in `KIT_RATE_LIMIT_FAIL_OPEN=1` with stderr warning + audit | ✅ shipped (P0.3) |
| `KIT_ELEVATED=1` bypassed gate without audit trail | Every elevation decision audit-logged; if audit-log itself fails, elevation refuses | ✅ shipped (P0.1) |
| `git commit --no-verify` undetected | Sentinel pair + skipped-commits log + startup banner | ✅ shipped (P0.4) |
| `KIT_PROD_OK=1` warning fired after credential already loaded | Warning at the read site, before credential resolved | ✅ shipped (P0.2) |
| Remote audit-log shipping was opportunistic (silent) | Opt-in via `[audit].remote = true` + one-time loud notice | ✅ shipped (T.4) |
| Vercel `upsertEnvVar` race window (delete → create gap) | PATCH fast-path + create-then-delete fallback with stale-id logging | ✅ shipped (P2.4) |
| Token store mode race (writeFile then chmod) | Atomic tmp + rename with `flag: "wx", mode: 0o600` on create | ✅ shipped (`edb29f7`) |

## Out-of-band controls (not OWASP-mapped)

- **Read-only mode** — not in the Top 10, but the strongest mitigation for
  agent-driven environments. Honored by 8+ write surfaces + all plugin
  mutating functions.
- **Per-vendor minimal-scope IAM templates** (`templates/iam/`) — front-loads
  the principle-of-least-privilege at token-creation time.
- **OneCLI gateway integration** (S8) — agent process sees only fake-keys;
  real values stay in OneCLI's daemon. Closes the prompt-cache-leak vector.

## Re-validation schedule

- **Quarterly** sweep: re-walk every category, verify shipped controls still
  function (i.e. tests still pass + flows still trigger gates as expected).
- **Per-OWASP update** (typically every 3-4 years): re-map the table when a
  new Top 10 edition lands.
- Memory: `feedback_owasp_2025` is the source-of-truth for category names.
