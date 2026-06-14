# kit Roadmap

State on **2026-06-02** — what's shipped, what's coming. Public-flip happens with
everything in **Shipped**; items in **Planned** land as incremental releases.

Contributions on any planned item are welcome — open an issue first to coordinate.

---

## Shipped (v1.1.x)

### Core
- `kit init / check / fix / install / login / secrets / setup / audit / doctor / env`
- `.kit.toml` config + Zod schema, `cli-lock.json`, `skills-lock.json`
- Mise integration for tool versions
- Git hooks management
- Skills system (`.claude/skills`)
- Plugin system + adapter SDK (`packages/adapter-sdk`, `packages/sandstream-kit-plugin-railway` reference)
- MCP server (`kit mcp`)
- Team / RBAC (`kit team`)

### Security
- `npm audit`, `semgrep`, `trivy`, `license-checker` (with `npx` fallback), `bumblebee`
  supply-chain scan, `secrets scan`, `.env` gitignore check
- Triage: `kit triage npm/pip/docker/repo/skill --sandbox`
- Test-coverage enforcement with universal baseline

### Secret backends
- `env` — `process.env`
- `1password` — `op read <ref>`
- `config` — literal value in `.kit.toml`
- `infisical` — bulk export via `infisical export --format=json`
- `bitwarden` — `bw get <field>`
- `doppler` — `doppler secrets get <name> --plain`
- `eas` — Expo Application Services secrets *(candidate for plugin extraction; see Planned)*
- `vault` — HashiCorp Vault KV v2
- `aws-sm` — AWS Secrets Manager
- `gcp-sm` — GCP Secret Manager
- `azure-kv` — Azure Key Vault
- `dotenvx` — encrypted `.env`-in-git via `dotenvx get`/`set` (ECIES)

### Brownfield UX
- `#`-prefixed informational service config no longer exec'd
- 1Password auth failures aggregate to one line instead of N
- `kit fix` auto-generates `.env.template` from `[secrets.keys]`
- `op signin` triggered automatically in `kit login / setup` when
  `secrets.store = "1password"`
- API-key patterns (Stripe, GitHub, AWS, GCP, Slack, JWT, OpenAI, Resend)
  redacted from `ServiceStatus.output` before audit / log persistence
- Interactive `kit init`: prompt for secret backend (9 options) instead
  of hard-coding 1Password; backend-specific `[secrets.keys]` syntax
- Plaintext-secret scan at init time: warns about credentials in `.env*`,
  `package.json`, `scripts/` with masked previews before backend is wired
- 1Password mode detection: `service-account` / `desktop-integration` /
  `eval-signin` / `no-account` / `not-installed` — actionable error per case

---

## Planned (post-flip, ordered by dependency)

Effort estimates assume one focused developer-day.

### PR 2 — `kit analyze` subcommand (1d)
Walk git log + scan framework markers (`next.config.*`, `pyproject.toml`,
`Cargo.toml`, `drizzle.config.*`, etc.) to emit a draft `CLAUDE.md` + `RULES.md`
suitable for committing. Pure pattern-mining for v1; LLM-augmented version after PR 4.

### PR 3 — Security-policy enforcement (1d)
Translate dependency-allowlist policy into `.kit-allowlist.json` +
`kit security policy` subcommand that fails the build on un-allowlisted deps
and queries the GitHub Advisory DB. Builds on existing `check-security.ts`.

### PR 4 — LLM provider abstraction (2-3d)
Add an `src/llm/` module exposing a single `runLLM({provider, model,
messages, tools})` interface covering Anthropic, OpenAI, OpenRouter, xAI,
Google, Mistral, Ollama. Retry/failover, rate-limit cooldown, cost accounting.
Wire into `kit triage` (LLM-summarized risk) and `kit skills` (relevance ranking).

### PR 5 — Agent telemetry rollup (1d)
Per-agent tokens / cost / quality metrics. Append to existing
`.kit-audit.jsonl`; new `kit ops --rollup` subcommand for summaries.
Depends on PR 4 for cost-accounting hooks.

### PR 6 — DeepEval-style quality gates (1-2d)
`kit eval` subcommand running golden-case suites with G-Eval, AnswerRelevancy,
Faithfulness, TaskCompletion metrics. PR-blocking at configurable threshold.
Depends on PR 4 (LLM-as-judge).

### PR 1.5 — Extract `eas` to `sandstream-kit-plugin-expo` (0.5d)
Move EAS-secrets case from core to a plugin alongside other Expo-specific tooling
(EAS build, app.json validation, OTA updates). Backward-compat via plugin
auto-load when `eas-cli` is detected.

### Plugin lineup (1-2d each, parallelizable)

Based on a survey of several real-world projects. Each plugin bundles: CLI install
+ service config + MCP server registration + skills install + domain code.

| Plugin | Hits | Priority | Domain code |
|---|---|---|---|
| `sandstream-kit-plugin-supabase` | 4 projects | P1 | migrations, types-gen, local stack, RLS verify, seed mgmt |
| `sandstream-kit-plugin-next` | 2+ projects | P1 | env promotion, build/deploy hooks, ISR cache mgmt |
| `sandstream-kit-plugin-expo` | 1 project | P1 | EAS build, app.json validation, OTA updates + eas-secrets |
| `sandstream-kit-plugin-stripe` | 2+ projects | P2 | products/prices sync, webhook registration, test-mode switch |
| `sandstream-kit-plugin-resend` | 2+ projects | P2 | template deploy, domain verification, webhook mgmt |
| `sandstream-kit-plugin-netlify` | 1 project | P3 | deploy + env mgmt |
| `sandstream-kit-plugin-vercel` | 1 project | P3 | deploy + env promotion |
| `sandstream-kit-plugin-capacitor` | 1 project | P3 | native build, plugin sync |
| `sandstream-kit-plugin-playwright` | 1+ projects | P3 | trace mgmt, browser install pinning |

### Agent-config injection — "teach the agent to use kit" (1-2d)
Today `kit setup` writes only `.kit.toml`; wiring an agent to actually *use* kit
is manual copy-paste from `examples/agent-hooks/`. Add an **opt-in** setup step
(`kit setup` prompt + standalone `kit agent-config`) that detects the agent(s)
present and injects a **managed, idempotent block** (BEGIN/END markers, re-runs
update in place) instructing the agent to run kit:

  - **Claude Code** → append the block to `CLAUDE.md`; optionally register a
    `.claude/settings.json` PostToolUse hook running `kit check --category security`.
  - **Codex** → block in `AGENTS.md` (per `examples/agent-hooks/codex`).
  - **Cursor** → `.cursorrules`; **Cline** → `.clinerules`.

Default to the doc-block only (safe, just text the agent reads); the
settings.json hook (which makes kit auto-run on the user's machine) is a
separate explicit confirm. Never overwrite outside the managed markers.

### Integration with OneCLI (1d)
New `[secrets.store = "onecli"]` backend that registers placeholder keys with
the OneCLI gateway (https://github.com/onecli/onecli) for runtime credential
injection. Complements existing config-time backends — kit writes
`.env.local` with the fake keys; OneCLI swaps them at HTTP-request time so
agents never see real credentials.

### Encrypted-env & agent-auth backends (dotenvx, SOPS, VestAuth/as2)
kit stays vault-agnostic — new sources slot in as backends, new identities as
adapters, rather than adopting one opinionated stack. Candidates, by adoption × fit:

  - **dotenvx** (✅ SHIPPED) — `[secrets.store = "dotenvx"]`. Encrypted-`.env`-in-git
    (ECIES AES-256 secp256k1; public key in `.env`, `DOTENV_PRIVATE_KEY` kept
    separate). ~6.5M downloads/wk, the `dotenv` successor — highest user demand.
    Resolve a key via `dotenvx get` / `dotenvx run`; pairs with the existing
    plaintext-scan + migrate flow (encrypt in place instead of moving to a vault).
  - **SOPS + age** (P1) — `[secrets.store = "sops"]`. The other dominant
    encrypted-secrets-in-git tool (age / cloud-KMS / PGP). Resolve via `sops -d`.
    Covers the IaC / k8s crowd that dotenvx doesn't.
  - **VestAuth** (P2) — adapter `vestauth/identity` + a "sign, don't store"
    secret mode. RFC 9421 HTTP Message Signatures give an agent a cryptographic
    identity and sign requests instead of carrying a long-lived key — eliminating
    some secrets outright. Strongest story-match with kit's "keys on the loose" thesis.
  - **as2 — Agentic Secret Storage** (P3) — `[secrets.store = "as2"]`. Hosted
    agent-secret store accessed over a VestAuth identity (`vestauth agent curl`).
    Resolve-only (kit reads from it, like aws-sm/gcp-sm); depends on the VestAuth
    adapter, so it lands after P2.

Competitive note: dotenvx + as2 + VestAuth (all @motdotla, the `dotenv` author) form a
vertically-integrated agent-secrets stack. kit's edge is the horizontal layer — setup +
supply-chain triage + governance/elevation **on top of** whichever store you use.
Support them as backends; watch **as2** as the closest competitor to kit's
secrets-resolution core.

### Secret-migration wizard (2d)
New `kit secrets migrate` subcommand that turns the init-time plaintext
warning into an actual move:

  1. Re-scan via `scanPlaintextSecrets` to find current plaintext credentials
  2. Confirm target vault (re-read `secrets.store` from `.kit.toml`)
  3. Install vault CLI if missing (via mise) and trigger login
  4. For each finding: push value to vault → record ref in `[secrets.keys]`
  5. Replace plaintext in source file with the appropriate vault reference
     comment (or remove and rely on `kit secrets` to regenerate)
  6. Verify by re-running scan — expect zero findings post-migration

### Secret rotation (PR R1-R4, ~5-7d)
Production rotation orchestration. Replaces a key everywhere it lives.

  - **R1**: `kit secrets rotate <KEY>` — generate-new-via-source-API
    (Stripe roll-keys, AWS IAM create-access-key, GCP IAM service-account key
    create), write to vault.
  - **R2**: Multi-target propagation adapters:
    - Vercel (`vercel env add/rm`)
    - GitHub Secrets (`gh secret set`)
    - Fly (`fly secrets set`)
    - Cloudflare Workers (`wrangler secret put`)
    - Railway (`railway variables set`)
    - AWS Parameter Store (`aws ssm put-parameter`)
  - **R3**: Revoke / delete old credential after smoke-test passes against
    new credential; rollback on failure.
  - **R4**: History scrubbing — redact rotated key from `.kit-audit.jsonl`,
    surface git-history scrubbing via `git-filter-repo`/`bfg` for accidentally
    committed credentials (opt-in, destructive — requires explicit `--force-history`).

### Short-TTL backend re-auth detection (1d)
Cloud secret backends (AWS Secrets Manager, GCP Secret Manager, Azure Key Vault,
HashiCorp Vault) have session lifetimes from 1h (AWS STS) to 32d (Vault policy).
When a `op read` / `aws secretsmanager get-secret-value` / `gcloud secrets
versions access` fails with an expired-token error, kit currently surfaces
the raw error. Improvement: detect the expiry error code per backend, suggest
the right re-auth command (`op signin`, `aws sso login`, `gcloud auth login`,
`az login`, `vault login`), and offer to re-run after auth.

---

## Considered and rejected

- **Third-party CLI tool-version lockers and skill-loaders** — evaluated several
  overlapping early-stage projects; kit's mise integration + `cli-lock.json` and
  its skills system already cover the same ground more completely, so no external
  code was adopted.
- **Agent-lifecycle / event-timeline subsystems** — duplicate or conflict with
  kit primitives (RBAC, audit log). Out of scope for kit's environment-manager
  remit.

---

## Out of scope

kit stays a developer-environment manager. It does **not** intend to become
an agent runtime, an orchestrator, or a hosted service. Anything that requires
a daemon, a remote backend, or a multi-agent coordination layer belongs in a
separate project — most likely OneCLI for credential proxying, or a dedicated
downstream orchestrator.
