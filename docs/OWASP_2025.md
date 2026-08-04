# kit ↔ OWASP Top 10 (2025)

> OWASP Top 10 2025 — how kit's shipped controls map to each category.
> Re-validated 2026-06-08.

Per memory `feedback_owasp_2025`, security reviews target the **2025** Top 10
(not 2021): A03 = supply-chain compromise (new), A10 = exceptional conditions
(new). kit's security posture is graded below.

## A01 — Broken Access Control

| kit control | Status |
|---|---|
| Read-only mode (`--read-only` / `KIT_READ_ONLY=1`) refuses every mutation | ✅ shipped (T.2) — with one gap closed later: `kit secrets propagate` wrote a secret into a third-party control plane with NO read-only check. Measured with elevation satisfied (`KIT_ELEVATED=1`): `KIT_READ_ONLY=1 kit secrets propagate API_KEY --value x --to vercel` reached `spawn vercel`. `read-only-surface.ts` omits `secrets` because it is "already refused inside their own modules" — true of the local write (`writeSecretToBackend`), false of propagation. Gated at `propagate()`'s choke point; the exclusion comment now warns to enumerate a command's WRITES rather than its modules. |
| Elevation-gate on destructive ops (`requireElevation` / `consumeElevation`) | ✅ shipped |
| Per-op scope mapping with one-shot consumption for irreversible ops | ✅ shipped (P2.5 `elevation-scopes.ts`) |
| `KIT_POLICY_HASH` exported for classifier consumption (content-addressed `[policy]` identity) | ✅ shipped (P1.3 `policy.ts`) |
| `[policy.agent_writes]` pre-approval consulted by kit's own write paths | ✅ **enforced, narrowing-only** — `policyRefuses()` (`policy-gate.ts`) gates all six vendor `env_set` writes at `propagate()`, the single choke point, so a caller cannot route around it. The semantic is deliberate and NOT a grant: the block is unsigned config, so an agent able to edit `.kit.toml` must not be able to self-approve — policy may add a denial and never remove one. Elevation, read-only and approval stay authoritative. Four distinct states (`inert` / `unconfigured` / `approved` / `denied`) keep "vendor absent" separate from "vendor declared with an empty list"; the latter refuses, as kit's own config comment always claimed. Every enforced decision — refusal AND grant — writes a `policy-check` audit event carrying the vendor, op, `policy_state` and policy hash, into the GOVERNED project's log. `inert`/`unconfigured` write nothing on purpose: they are the absence of an opinion, and logging them would bury the two states that carry information. Proof: `src/policy-gate.test.ts`, 26 tests organised by the five ROADMAP traps, mutation-proved eight ways (remove the wiring → 2 fail; empty list permissive → 5; collapse absent-vendor → 5; stop auditing → 4; audit every state → 1; audit into `process.cwd()` → 3; remove the read-only gate → 3; run policy before read-only → 2). |
| RBAC model + decision-path tests | ✅ shipped (`rbac/policy-schema.ts` + `rbac/resolve.ts`, with `rbac/policy-schema.test.ts` + `rbac/resolve.test.ts`) |

## A02 — Cryptographic Failures

| kit control | Status |
|---|---|
| Token store `~/.kit/mcp-tokens.json` atomic write + mode 0o600 on create | ✅ fixed (security-review caught race window — `edb29f7`) |
| Parent dir `~/.kit/` chmod 0o700 | ⚠️ **not on every path** — measured 2026-08-03: with `kit identity init` as the FIRST command the dir lands at **0755**. The files inside are 0600, so no secret is world-READABLE, but the directory is world-traversable, which matters on a shared runner. Reproduce: `HOME=$(mktemp -d) kit identity init && stat -c '%a' $HOME/.kit`. |
| Secret values redacted in error messages (`safeStatusLine()` truncation + `redactSecrets()`) | ✅ shipped, for **26 recognised vendor shapes** (`utils/redactSecrets.ts`). It is a pattern list, not a universal filter: a Postgres/MySQL password, a self-hosted Sentry or Vault token, or an HTTP basic-auth secret matches none of them and would pass through. "Never echoed" was too strong; the truncation in `safeStatusLine()` is the backstop that does not depend on recognising the shape. |
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
| GitHub artifact attestation cross-verification | ✅ shipped **from 6.3.2**, and this row previously proved the wrong thing. Its evidence was "the `actions/attest-build-provenance` step is in publish.yml" — the step WAS there, and errored in 327 ms on every release (`subject-path: dist/**/*` = 1920 files vs the action's 1024-subject limit) while `continue-on-error: true` reported it to the jobs API as success. Presence of a step is not evidence that it ran. The evidence now is the consumer-side measurement: `gh attestation verify sandstream-kit-6.3.2.tgz --repo sandstream/kit` exits 0 with exactly ONE subject, `digest.sha256 = de2f6328…85dd`, against a tarball whose sha512 equals npm's own `dist.integrity` — so the GitHub attestation and the npm provenance describe the same bytes. Run `30890753307`. Nothing to verify on ≤6.3.1. |
| CycloneDX + SPDX SBOM published per release | ✅ shipped |
| GPG-signed tags required by publish.yml | ✅ shipped (T.5) |
| `sandstream-kit-plugin-snyk` + `sandstream-kit-plugin-wiz` — read-only scanner-result ingestion | ✅ shipped (T.6) — **and installable since 6.3.1**: both are on npm (HTTP 200, checked 2026-08-03), alongside `sandstream-kit-adapter-sdk@1.0.0`. Before that release the code existed only in this monorepo, so the control was unreachable to anyone who had not cloned it. |
| `docs/VERIFY.md` documents the operator-side verification flow | ✅ shipped |

## A04 — Insecure Design

| kit control | Status |
|---|---|
| Trust model + data-flow are explicit docs (`THREAT_MODEL.md`, `DATA_FLOW.md`) | ✅ shipped (T.1) |
| `[policy.agent_writes]` makes agent-permitted scopes EXPLICIT, not implicit | ✅ **enforced for the ops in the registry** — `POLICY_OPS` (`policy-gate.ts`) is the single op vocabulary both the caller and the operator read, and `unknownPolicyEntries()` reports config naming an op kit never asks about, so a typo'd `env-set` surfaces instead of leaving the operator believing it granted something. Coverage is the six propagation targets' `env_set` plus Supabase rotation, where `scoped_key_mint` and `jwt_secret_roll` are SEPARATE ops because the roll invalidates every live token and a mint approval must not authorise it. The plugin ops (`resolve_issue`, `create_release`, `trigger_deploy`) still have no choke point in kit. A test parses the example out of `config.ts` and runs it through `unknownPolicyEntries`, so kit's own documentation cannot name an op the registry rejects — it did before this arc (`rotate_jwt`, and `list_projects`, a READ inside a block called `agent_writes`). Enforced decisions are audited: `enforcePolicy()` records both refusals and grants with the vendor, op, state and policy hash. `checkPolicy()` in `policy.ts` now DELEGATES its decision to the same `policyDecision`, so there is exactly one function answering this access question — two independent implementations of one rule is the divergence class that left `kit_fix`'s MCP handler with a stale copy of the lock step. |
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
| Dependabot for SHA-pinned actions in `.github/workflows/*` | ✅ shipped (`.github/dependabot.yml`, `github-actions` ecosystem, weekly, grouped; npm deliberately not enabled — dep changes go through `kit triage`) |
| Bumblebee deep-scan in CI | ✅ shipped |
| `kit security policy` validates dep allowlist | ✅ shipped |
| OpenSSF Scorecard run — weekly (Mon 04:17 UTC) + every push to `main` + on branch-protection change | ✅ shipped (`.github/workflows/scorecard.yml`; analysis and SARIF upload are `continue-on-error`, so a Scorecard outage never blocks a merge — and never fails the workflow either, so this is a reporting signal, not a gate) |
| Dependency surface: what kit installs vs what it executes | ⚠️ **120 installed, 9 loaded** — measured, not estimated. kit has FOUR direct production dependencies (`@modelcontextprotocol/sdk`, `@upstash/redis`, `smol-toml`, `zod`) and the SDK alone accounts for **91 of the 120** packages, because it declares 17 hard dependencies (`optionalDependencies: {}`) including a complete HTTP server + OAuth stack — express 5, express-rate-limit, cors, hono, @hono/node-server, raw-body, content-type, eventsource, jose, pkce-challenge — for the Streamable-HTTP/SSE transports. kit speaks **stdio** and loads none of them: proven by tracing both module systems while booting the server, listing tools and calling two (`src/mcp-dependency-surface.test.ts`, which is a GUARD — it fails if a future SDK release pulls the HTTP stack into the stdio path). This is inherited surface, not executed code, and the distinction decides how to read any advisory in it. |
| Advisory triage: live path vs inherited surface | ⚠️ **not every advisory is equal, and one was misreported.** Of four cleared in one sitting: `hono` and `ip-address` (via express-rate-limit) sit in code kit **never loads**; `brace-expansion` was dev-only (via eslint); **`fast-uri` is on the live path** — `ajv` compiles kit's ten MCP tool schemas on every server start and resolves `$ref` URIs through it. The `fast-uri` bump's own commit message implied it was as untouched as `hono`; that was wrong, and the trace above is what corrects it. The measurement needed BOTH an ESM resolve hook and a `Module._load` patch: `ajv` is CommonJS, so an ESM-only tracer reports 6 packages, omits `fast-uri`, and produces a confident wrong answer. |

## A07 — Identification & Authentication Failures

| kit control | Status |
|---|---|
| TOTP enrollment + verification on elevation | ✅ shipped (RFC 6238 inline impl) |
| 15-minute default elevation TTL; one-shot scopes for jwt-secret-roll / purge-history / onecli-register | ✅ shipped |
| `KIT_ELEVATED=1` CI escape hatch emits loud stderr warning + audit event | ✅ shipped |
| `KIT_PROD_OK=1` warning at the read site (not the consumer site) | ✅ shipped (P0.2) |
| `KIT_NON_INTERACTIVE=1` emits one-time stderr warning + audit | ⚠️ **TTY-conditional, so silent in the case it exists for** — `environment.ts:137,142` guard the warning with `if (process.stdout.isTTY)`. A CI job or agent harness that sets the flag and captures stdout gets no warning and no audit event; only a human at a terminal sees it. Backwards from the intent. |
| MCP token store separate from raw vault — bearer with vendor-supplied expiry, not a refresh token | ✅ shipped (P1.2), with the limit named: `McpToken.expiresAt` is **optional and best-effort** (`mcp-orchestrator.ts:41`). When the vendor supplies it, kit honours it and `kit mcp status` reports `expired … — re-authorize` (lines 130-138). When the vendor does not, the stored bearer has no lifetime and kit neither mints nor enforces one. "Short-lived" describes the intended token class, not a property kit guarantees. |

## A08 — Software & Data Integrity Failures

| kit control | Status |
|---|---|
| SLSA provenance on every release | ✅ shipped |
| Signed git tags required to publish | ✅ shipped (T.5) |
| Pre-commit hook sentinel + post-commit detector log `--no-verify` skips | ✅ shipped (P0.4) |
| `kit security verify-pull` post-merge audit: new deps, gitignore drops, introduced secrets | ✅ shipped |
| Audit-log atomic write (tmp + rename) | ⚠️ **describes the remote QUEUE, not the log** — `audit.ts:436` does tmp+rename for the retry queue; the log line itself is a plain `appendFile` (`audit.ts:93`). A single small append under O_APPEND does not interleave in practice, but two concurrent kit processes can still both read the same tail hash, and "tmp + rename" is not what protects the log. |
| Vercel `upsertEnvVar` atomic (PATCH fast-path; create-then-delete fallback) | ✅ shipped (P2.4 earlier) |

## A09 — Security Logging & Monitoring Failures

| kit control | Status |
|---|---|
| `.kit-audit.jsonl` append-only; every destructive op logged | ✅ shipped |
| `.kit-skipped-commits.jsonl` records `git commit --no-verify` events | ✅ shipped |
| `.kit-scan-results.jsonl` INGESTION contract — kit reads external findings into the verdict | ✅ shipped (`external-findings.ts`: "a tool appends one JSON object per line"; `check-security.ts:2139` folds it in, can only escalate). The Snyk and Wiz plugins emit it. **Nothing in kit writes Bumblebee findings there** — that half was a claim about a producer kit does not control. |
| `appendAuditEventDirect` fail-closed (caller refuses if audit-log write fails) | ✅ shipped |
| `[governance.audit].remote = true` opt-in for centralized log shipping with retry-queue | ⚠️ **the transport exists; nothing reaches it** — `logAuditEvent` guards the remote branch with `if (companyId && …)` and `companyId` is an OPTIONAL third argument that **all 11 production callers omit** (governance-middleware ×7, doctor, memory, broker, gate). So setting the flag ships nothing, in either direction. The POST path, retry queue and tmp+rename parking are implemented and unreachable. Verify: `grep -rn 'logAuditEvent(' src --include=*.ts \| grep -v test`. |
| Sentry integration (`sandstream-kit-plugin-sentry`) for issue triage + release tagging | ✅ shipped (P1.1) |
| Cost-monitor anomaly detection with rolling baseline (EMA) | ⚠️ **algorithm only, not wired** — `detectCostAnomalies` (cost-monitor.ts) has **0 callers** outside its own tests, and no command produces `.kit-cost-baseline.json`. Verify: `grep -rn detectCostAnomalies src --include=*.ts \| grep -v test \| grep -v cost-monitor.ts`. |

## A10 — Exceptional Conditions (NEW in 2025)

This is the newly-added category — error-handling, fallback behavior, race
conditions, and degraded-mode operation. kit's audit found multiple
fail-open paths in pre-2026-06 versions; all are now fail-closed:

| Pre-2026-06 (BAD) | Post-2026-06 (FIXED) | Status |
|---|---|---|
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
