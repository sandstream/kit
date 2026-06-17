# kit

> One command from `git clone` to fully working dev environment.

For AI agents and humans. Manages tools, auth, secrets, and project setup. Zero LLM calls, local-first, multi-vault.

🌐 [sandstre.am/kit](https://sandstre.am/kit)

## Quick start

**Prerequisites:** Node.js 22+, git, and [mise](https://mise.jdx.dev) for installing tools (`brew install mise`, or `curl https://mise.run | sh`).

```bash
# zero install (also sidesteps npm -g permission issues):
npx sandstream-kit setup

# or install globally:
npm i -g sandstream-kit
# if npm -g is permission-blocked, use a user-owned prefix instead of sudo:
#   npm config set prefix ~/.npm-global
#   echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc
```

Then, in a repo:

```bash
kit init           # detect the stack → generate .kit.toml
kit check          # what's set up vs missing (tools, services, secrets, hooks, security)
kit setup          # install tools (via mise), git hooks, logins, secrets
kit context check  # lock each CLI to the declared account + project (no wrong-org pushes)
```

## Problem

Every time you (or an agent) starts on a new project:
- Missing CLI tools (supabase, vercel, eas, gcloud...)
- Not logged in to services
- Missing API keys and secrets
- Wrong versions
- No idea what's needed

## Why kit exists

The same wall kept showing up, for a human at a new laptop and for an AI agent in a
fresh checkout: API keys scattered across `.env` files, shell history and password
managers (some live, some expired, none in one place); the same setup prompts burning
tokens to rediscover what the last session already knew; and an agent one `npm install`
away from pulling a package nobody vetted.

kit makes "get this project running, safely" declarative and repeatable: one config
materializes tools, logins and secrets the same way every time, keeps credentials in a
vault instead of on the loose, and puts a pre-install **triage** step in front of new
dependencies so an unknown package gets looked at before it lands. Zero LLM calls,
local-first, no telemetry, the intelligence stays where you put it.

## kit is not another scanner

You already have Semgrep, Snyk, Trivy, Socket, your linters. kit does not compete
with them. It runs them, folds in their results, and adds the layer they do not have.

- **They go deep on one axis** (code vulns, dependency CVEs, container images). kit
  goes **broad across the whole setup lifecycle**: tools, auth, secrets and vaults,
  git hooks, supply-chain triage, env routing, memory, governance. One command from
  `git clone` to a working, secret-safe environment.
- **kit orchestrates, it does not replace.** `kit check` runs Semgrep, Trivy and
  Socket when present; the `snyk` and `wiz` plugins ingest their findings; everything
  lands in one consolidated report next to kit's own checks, each with a remediation
  step.
- **The one gate your agent runs.** Before an AI agent acts it runs `kit review` once
  and gets a single deterministic verdict across every source. No agent, no socket,
  no telemetry, zero LLM calls. Your code never leaves the machine.

Use kit **with** your scanners. It is the connective tissue that turns them into one
local-first, agent-native gate.

## Solution

`.kit.toml` per project:

```toml
[tools]
node = "22"
pnpm = "latest"
supabase = "2.78"

[services.supabase]
login = "supabase login"
check = "supabase projects list"
link = "supabase link --project-ref {project_ref}"
project_ref = "your-project-ref"

[services.vercel]
login = "vercel login"
check = "vercel whoami"

[services.stripe]
login = "stripe login"
check = "stripe config --list"
# auth strategy is inferred (interactive here, since a `login` command exists);
# override explicitly with: auth = "vault" | "capture" | "interactive"
# `kit login --plan` shows the resolved strategy per service before logging in.

[secrets]
store = "1password"  # or env, dotenvx, vault, aws-sm, gcp-sm, azure-kv, infisical, doppler, bitwarden, eas
template = ".env.template"

[secrets.keys]
SUPABASE_URL = { source = "config", value = "https://{supabase.project_ref}.supabase.co" }
STRIPE_SECRET_KEY = { source = "1password", ref = "op://Development/Stripe/secret-key" }
REVENUECAT_KEY = { source = "eas", name = "REVENUECAT_APPLE_API_KEY" }

[setup]
install = "pnpm install"
migrate = "supabase db push"
seed = "pnpm seed"
verify = "pnpm dev & sleep 5 && curl localhost:3000"
```

## Commands

Complete reference: [`docs/COMMANDS.md`](./docs/COMMANDS.md). The shortlist:

- `kit init`: Auto-detect project stack → generate `.kit.toml`
- `kit setup`: Full pipeline: install → hooks → login → secrets → check
- `kit check`: Status of tools, services, secrets, hooks, security, tests
- `kit fix`: Auto-remediate gaps (tools, gitignore, hooks, .env.template)
- `kit login --plan`: Show the resolved auth strategy (vault/capture/interactive) per service without logging in
- `kit secrets {set,migrate,rotate,propagate,onecli,validate}`: Secret lifecycle
- `kit memory {index,search,suggest,pal,share,backup}`: Local-first second brain + pending-action ledger
- `kit auth {elevate,setup-totp,status,revoke}`: Elevation gate + TOTP
- `kit mcp {list,auth,set-token,clear}`: MCP-server orchestrator
- `kit env {list,switch,current,diff}`: Environment routing + drift detection
- `kit context {check,use,--prompt}`: Lock each CLI to its declared account + project (no wrong-org pushes)
- `kit triage {npm,pip,docker,repo,skill}`: Pre-install security check
- `kit security {scan-build,scan-staged,verify-pull,costs,policy}`: Security ops
- `kit hooks {install,add,sync}`: Git hooks + bypass detector
- `kit governance` / `kit audit`: Policy + audit-log inspection
- `kit --read-only <subcommand>`: Session-wide refusal of all writes

### What you'll see

`kit init`, detects the stack, previews `.kit.toml`, then runs setup:

```text
kit init
──────────────────────────────────────────────────
  ✓ Detected: TypeScript / Next.js  (confidence: 92%)

Preview, .kit.toml
  + [tools]
  + node = "22"
  ...
  ✓ Generated .kit.toml
```

`kit setup`, six-stage pipeline, each stage gated on the last:

```text
kit setup
──────────────────────────────────────────────────
[1/6] Install
  ✓ node  installed  v22.22.2
[2/6] Git Hooks    ✓ pre-commit installed
[3/6] Login        ✓ supabase authenticated
[4/6] Secrets      ✓ Wrote .env.local (from keys)
[5/6] Agent config ✓ Claude Code → CLAUDE.md (created)
[6/6] Verify
Setup complete, you're ready to go! ✓
```

Step 5 teaches the agent in the repo (Claude Code, Codex, Cursor, Cline) to
*use* kit, it writes a small managed "run kit check / triage before install /
vault your secrets" block into the agent's rules file (`CLAUDE.md`, `AGENTS.md`,
`.cursorrules`, `.clinerules`). Run it standalone any time with `kit agent-config`.
The block is regenerated in place on re-run; edit outside its markers freely.

`kit check`, grouped status tables with a pass/fail summary:

```text
Tools
  ✓ node          22.22.2  (need 22)
  ✗ supabase      not installed  (need 2.78)
Services
  ✓ vercel        authenticated
Security
  ✓ .env gitignored      pass   all .env patterns in .gitignore
  ✓ pinned versions      pass   all dependencies pinned

7/8 checks passed  (1 issues)
Run kit install to fix tools, kit login to fix auth
```

`kit fix`, six remediation steps, then a fixed/manual summary:

```text
kit fix
──────────────────────────────────────────────────
[1/6] Tools        ✓ supabase  installed  v2.78.0
[2/6] Lock Files   ✓ Generated cli-lock.json
[5/6] .gitignore   ✓ Added 2 pattern(s) to .gitignore
[6/6] Git Hooks    ✓ Installed 1 hook(s): pre-commit

Summary
  ✓ Fixed 4 issue(s) automatically
  ! 1 issue(s) require manual intervention:
     • Login to stripe: run 'kit login' or 'stripe login'
```

`kit secrets`, resolves each key from the vault and writes `.env.local`:

```text
Generating secrets...  (env=dev)

  ✓ SUPABASE_URL        resolved  Derived from config
  ✓ STRIPE_SECRET_KEY   resolved  op://Development/Stripe/secret-key
  ✗ REVENUECAT_KEY      missing   not found in eas

  ✓ Wrote .env.local (from keys)
```

`kit triage <type> <target>`, security verdict before you install:

```text
Running triage on npm: left-pad

Health score: 7/10
Critical issues: 0
Warnings: 1
TRIAGE PASSED
```

Trust model documented in [`docs/THREAT_MODEL.md`](./docs/THREAT_MODEL.md);
data flow per command in [`docs/DATA_FLOW.md`](./docs/DATA_FLOW.md);
release-verification in [`docs/VERIFY.md`](./docs/VERIFY.md).
- `kit doctor`: Deep diagnostics: Node.js version, mise, .env.local, tools in PATH, git hooks
- `kit env`: Inspect environment variables from .env.local (`--show-values`, `--missing`, `--json`)
- `kit mcp`: Run the MCP server over stdio for AI assistants (auto-detected: no sub-command + non-TTY). Interactively, `kit mcp list|auth|set-token|clear` manages declared servers
- `kit analyze`: Detect stack + emit draft `CLAUDE.md` / `RULES.md` from git history + framework markers

### Secrets management

End-to-end secret lifecycle, from `.env*` plaintext discovery, through vault
migration, to deploy-platform propagation, to destructive history cleanup.

- `kit secrets`: Materialize `.env.local` from the configured vault store
- `kit secrets set <KEY> --stdin | --value <v>`: Capture a value straight into the vault (stdin-safe, never in argv). The execution behind a service's `auth = "capture"` strategy
- `kit secrets migrate`: Move plaintext credentials from `.env*` into the vault
- `kit secrets rotate <KEY>`: Mint a new value (`--random` opaque token / `--value <new>` explicit)
- `kit secrets rotate <KEY> --from-cli`: Provider-native playbooks (Stripe / AWS-IAM / GCP-IAM / GitHub PAT / OpenAI)
- `kit secrets rotate <KEY> --via supabase-mgmt-api --project <ref>`: Full automation via Supabase Mgmt API. Auto-detects scoped-key-mint vs jwt-secret-roll.
- `kit secrets propagate <KEY> --to vercel,github,...`: Push value to deploy targets (stdin-safe via `--stdin`)
- `kit secrets revoke-old --via supabase-mgmt-api --key-id <id>`: Revoke a previously-minted scoped key
- `kit secrets onecli register <KEY> --host <pattern>`: Register with the OneCLI gateway so the agent process never sees the real value
- `kit secrets purge-history <pattern> --force-history`: Destructive: rewrite git history to scrub a leaked value (wraps `git filter-repo` / `bfg`). Requires elevation + explicit flag.

### Security scanners

- `kit security scan-staged`: Pre-commit: scan staged blobs for known credential patterns
- `kit security scan-build`: Walk `.next/`, `dist/`, `build/` for credentials inlined into artifacts (`NEXT_PUBLIC_` typos)
- `kit security scan-transcripts`: Walk `.claude/`, `~/.claude/projects/`, `.opencode/` for replayed-secret leaks
- `kit security check-gitignore [--fix]`: Verify `.env*`, `*.pem`, `id_rsa`, `.kit/elevation.json` are ignored
- `kit security verify-pull [--base <ref>]`: After `git pull`: audit new deps, gitignore drops, introduced secrets, policy changes
- `kit security policy [init|add <pkg>|check]`: Dependency allowlist enforcement + per-key spend caps/TTL/scope
- `kit security costs`: Snapshot per-key spend vs policy cap (Stripe live; OpenAI/Anthropic/Resend/Vercel stubbed)
- `kit security clear-cache`: Reset the cached supply-chain scanner binary (use after an intentional rebuild)

### Built-in git hooks

`kit hooks add <name>` installs a managed hook that calls back into kit. No `.kit.toml` config required.

- `secret-scan` (pre-commit): Block commits that introduce known credential patterns
- `post-pull-audit` (post-merge): Run `verify-pull` after every `git pull` / merge
- `context-check` (pre-push): Block a push when the live CLI context does not match `.kit.toml [context]` (see Context lock)

### Environments + elevation

Production credentials are gated behind explicit env-switching and short-lived elevation.

- `kit env switch <dev|staging|prod>`: Toggle the active environment marker
- `kit env current`: Show active env (color-coded), `kit env list` for available
- `kit auth elevate [--scope <op>] [--ttl-minutes N]`: Mint a TTL'd elevation marker (TOTP or yes-prompt). Required before any destructive secret op.
- `kit auth setup-totp`: One-time TOTP enrollment (writes `~/.kit/totp-secret` 0600)
- `kit auth status`: Show active elevation
- `kit auth revoke`: Drop the elevation marker early
- `kit audit secrets [--since-days N] [--key <name>]`: Forensics: who touched which key, when

### Context lock

When you work across several accounts and projects (gcloud, Vercel, GitHub, npm) it is easy to be in the wrong one without noticing, and a logged-in account plus a selected project are not assumed to belong together. Declare the exact pair per repo and kit verifies the live tools against it:

```toml
[context]
gcloud = { account = "ops@acme.com", project = "acme-prod", config = "acme", region = "europe-west4" }
vercel = { team = "team_…", project = "prj_…" }   # the ids in .vercel/project.json
github = { org = "acme", remote = "github.com/acme/app" }
git    = { email = "you@acme.com" }
npm    = { registry = "https://registry.npmjs.org" }
```

- `kit context check`: verify the live account+project of each CLI matches the declaration. A right account with the wrong project is a mismatch, not a pass. Read-only; exits non-zero so it can gate.
- `kit context use`: activate the declared context (gcloud config + repo git identity). Touches only local config, never an account or a deploy.
- `kit context --prompt`: a fast, read-only indicator (e.g. `[gcp:acme-prod]`) for your shell prompt, so the context you are in is always visible.
- `kit hooks add context-check`: install a pre-push hook so a push to the wrong org/project is blocked before it leaves the machine.

Context pointers are non-secret and live in config; the credentials they authenticate with stay in the vault.

### Quality gates (baseline-aware)

- `kit check --enforce-tests`: Fail when net-new source files lack a sibling `.test.ts`
- `kit design`: Static a11y scan (img-alt, button-empty, anchor-no-href, input-no-label) + design-token consistency (raw `#hex` / `px` bypass). `--enforce` to gate, `--json` for machine output
- `kit review`: Meta-runner: `check` + `design` in one command. Use as a single PR-gate entry point for AI agents
- `kit baseline freeze`: Snapshot current findings (untested files, a11y, tokens) into `.kit-baseline.json` so pre-existing warnings stay warnings and only net-new findings can fail
- `kit baseline show`: Print current baseline

### Supply chain

- **Bumblebee**: Built-in supply-chain scanner. Verifies every dependency against pinned SHA-256 checksums in `bumblebee.lock.json`. Re-verifies the cache before reuse so a tampered local file is caught (kind `integrity`). Runs in CI on every PR
- `kit triage npm|pip|docker|repo|skill <target>`: Pre-install security evaluation via triage skill
- `kit triage npm <pkg> --sandbox`: Offline behavioral inspection: `npm pack` → extract → scan for install scripts, eval/base64/network patterns, unexpected scripts, oversized files. No code executes
- Supply-chain findings auto-append to `.kit-audit.jsonl` (one JSON line per finding) for SIEM ingest
- Releases ship with SLSA provenance (`npm publish --provenance`), CycloneDX + SPDX SBOMs on every GitHub release, cosign-signed Docker images, and weekly OpenSSF Scorecard

## Memory

`kit memory` gives an agent a local-first, deterministic second brain, it stores
your raw conversation history and searches it *before answering*, so it pulls
receipts instead of guessing. SQLite + FTS5, two hooks, no vectors, no model calls.
It indexes transcripts from **seven** coding agents (Claude Code, Codex, Gemini,
Continue, Cursor, Amazon Q, and Cline), each parsed against the agent's own
serialization format, never guessed. A private personal tier (encrypted backup so a
stolen laptop doesn't lose your context) plus a curated, area-organized **shared**
tier that travels with the repo and is reviewed like code.

```bash
kit memory install && kit memory index
kit memory search "what did we decide about X"   # project-scoped recall
kit memory area stripe                            # shared: how we built it, status, security
kit memory suggest | your-llm                     # zero-LLM core; pipe a review prompt to YOUR model
```

Full reference: [`docs/MEMORY.md`](docs/MEMORY.md). Schema + two-hook design
credited to [cloudctx](https://github.com/chadptk1238/cloudctx) (MIT).

## Lock Files

kit uses lock files in `.kit/` to track exact versions of skills and tools:

- `.kit/kit.json`: Identifies which kit this project uses (e.g., "sandstream/standard@1.3.0")
- `.kit/skills-lock.json`: Agent skills with versions and metadata
- `.kit/cli-lock.json`: CLI tools with versions and installation sources

This allows teams to codify and version their development methodology, similar to `package-lock.json` for dependencies.

```bash
kit init      # Generate lock files and setup project
kit upgrade   # Update lock files from .kit.toml
kit check     # Verify lock files are in sync
```

## Service Provisioning

kit can automatically provision and configure services for your project, designed for agent-native workflows (no browser required):

```bash
kit add stripe/payments    # Set up Stripe with API keys
kit add supabase/db        # Initialize Supabase project
kit add vercel/hosting     # Link repository to Vercel
```

### How it works

1. Checks if the service CLI is installed and authenticated
2. Provisions resources via CLI/API (no browser needed)
3. Extracts credentials and configuration
4. Writes secrets to `.env.local`
5. Records provisioning metadata in `skills-lock.json`

### Available Services

- **stripe/payments**: Payment processing with Stripe
  - Requires: `stripe` CLI ([install](https://stripe.com/docs/stripe-cli))
  - Provisions: API keys, creates test mode configuration
  - Secrets: `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`
  - Example:
    ```bash
    brew install stripe/stripe-cli/stripe
    stripe login
    kit add stripe/payments
    ```

- **supabase/db**: Database and authentication with Supabase
  - Requires: `supabase` CLI ([install](https://supabase.com/docs/guides/cli))
  - Provisions: Local dev instance or links existing project
  - Secrets: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
  - Example:
    ```bash
    brew install supabase/tap/supabase
    supabase login
    kit add supabase/db
    ```

- **vercel/hosting**: Hosting and deployment with Vercel
  - Requires: `vercel` CLI ([install](https://vercel.com/docs/cli))
  - Provisions: Links repository, sets up deployment
  - Secrets: `VERCEL_PROJECT_ID`, `VERCEL_ORG_ID`
  - Example:
    ```bash
    npm i -g vercel
    vercel login
    kit add vercel/hosting
    ```

- **expo/eas**: Mobile app builds with Expo EAS
  - Requires: `eas` CLI ([install](https://docs.expo.dev/eas/))
  - Provisions: EAS project, build configuration
  - Secrets: `EXPO_TOKEN`, EAS credentials
  - Example:
    ```bash
    npm i -g eas-cli
    eas login
    kit add expo/eas
    ```

- **searxng/instance**: Privacy-respecting search engine
  - Requires: `docker` and `docker-compose`
  - Provisions: Local SearXNG instance
  - Secrets: `SEARXNG_URL`, `SEARXNG_SECRET`
  - Example:
    ```bash
    kit add searxng/instance
    ```

The full adapter set (each provisions/reuses the relevant keys; run `kit add <id>`):

| Service | Purpose |
|---|---|
| `stripe/payments` | Stripe payment processing (products + price IDs) |
| `supabase/db` | Supabase database + authentication |
| `vercel/hosting` | Vercel hosting + deployment |
| `flyio/hosting` | Fly.io container deployment |
| `railway/hosting` | Railway (Heroku-style) deployment |
| `neon/db` | Neon serverless Postgres |
| `planetscale/db` | PlanetScale serverless MySQL |
| `upstash/redis` | Upstash serverless Redis |
| `cloudflare/r2` | Cloudflare R2 object storage (S3-compatible) |
| `clerk/auth` | Clerk authentication + user management |
| `resend/email` | Resend transactional email |
| `loops/email` | Loops marketing + transactional email |
| `sentry/monitoring` | Sentry error tracking + performance monitoring |
| `posthog/analytics` | PostHog product analytics + session recording |
| `tinybird/analytics` | Tinybird real-time analytics on ClickHouse |
| `liveblocks/realtime` | Liveblocks collaborative realtime (presence, cursors) |
| `trigger/background` | Trigger.dev background jobs |
| `inngest/background` | Inngest event-driven background jobs |
| `flagsmith/flags` | Flagsmith feature flags + remote config |
| `expo/eas` | Expo Application Services (mobile builds) |
| `searxng/instance` | Self-hosted SearXNG search engine |

Add your own with `kit create-plugin <name>` (see [docs/PLUGIN_DEVELOPMENT.md](./docs/PLUGIN_DEVELOPMENT.md)).

### Example Workflows

**New project setup:**
```bash
# Clone project
git clone https://github.com/user/my-app
cd my-app

# Check what's needed
kit check

# Provision all services at once
kit add stripe/payments
kit add supabase/db
kit add vercel/hosting

# Verify everything is configured
kit check
```

**Agent-driven provisioning:**
```bash
# Agent provisions services automatically
kit add stripe/payments
# → Checks if stripe CLI installed
# → Verifies authentication
# → Creates API keys
# → Writes to .env.local
# → Updates skills-lock.json

# Check what was provisioned
cat .env.local | grep STRIPE
cat skills-lock.json | jq '.provisioned["stripe/payments"]'
```

**Creating custom adapters:**

See [docs/CUSTOM_ADAPTERS.md](./docs/CUSTOM_ADAPTERS.md) for a complete guide on creating custom service adapters.

**Troubleshooting:**

Common issues and solutions:
- **"Required tool not installed"**: Install the service's CLI tool (see examples above)
- **"Not authenticated"**: Run the service's login command (e.g., `stripe login`)
- **"Provisioning failed"**: Check CLI is in your PATH: `which stripe`
- For more help, see [docs/CUSTOM_ADAPTERS.md](./docs/CUSTOM_ADAPTERS.md#troubleshooting)

## Agent Integration

Agents run `kit check` at start. If anything fails:
1. Auto-fix what's possible (`kit fix`)
2. Escalate to human what requires browser auth (`kit escalate`)
3. Continue working on what's available

## Governance & Access Control

kit includes governance features for managing agent access to production systems:

```toml
[governance]
enabled = true
environment = "dev"  # dev, staging, prod

[governance.access]
dev = { read = true, write = true, delete = true }
staging = { read = true, write = true, delete = false }
prod = { read = true, write = false, delete = false }

[governance.agent]
id = "agent-123"
name = "Founding Engineer"
max_tokens_per_day = 1000000
max_operations_per_hour = 100

[governance.audit]
enabled = true
log_file = ".kit-audit.jsonl"

[governance.approval]
destructive_operations = ["delete", "drop", "truncate"]
production_writes = true

[governance.revocation]
enabled = true
revocation_endpoint = "https://audit.example.com/agents/{agent_id}/status"
```

### Features

- **Environment-based access control**: Different permissions per environment
- **Audit logging**: All operations logged with automatic secret redaction
- **Budget limits**: Token (daily) and operation (hourly) tracking
- **Approval gates**: Interactive prompts for destructive operations
- **Revocation**: Remote status checking via API
- **Secret expiration**: Monitoring with warnings for expiring secrets

### Environment Detection

kit automatically detects the current environment using:
1. **NODE_ENV** environment variable (highest priority)
2. **Git branch** name (fallback: main/master→prod, staging→staging, others→dev)
3. **Default** to dev if neither is available

Set NODE_ENV in your `.env.local`:
```bash
# Options: development, staging, production
NODE_ENV=development
```

This affects governance access control, security policies, and audit logging.

See [GOVERNANCE.md](./GOVERNANCE.md) for detailed documentation.

## AI Assistant Setup

kit exposes its capabilities as an MCP server, making it usable directly by Claude Code, Cursor, Windsurf, Cline, and any other MCP-compatible AI assistant. Once registered, assistants can call `kit_check`, `kit_fix`, `kit_add`, and other tools without leaving their context.

### Claude Code

A template config is included at `claude-mcp.json`. Copy it to activate:

```bash
cp claude-mcp.json .claude/mcp.json
```

Or add manually to `.claude/mcp.json` (or `~/.claude/mcp.json` for all projects):

```json
{
  "mcpServers": {
    "kit": {
      "command": "npx",
      "args": ["sandstream-kit", "mcp"]
    }
  }
}
```

Or if installed globally (`npm install -g sandstream-kit`):

```json
{
  "mcpServers": {
    "kit": {
      "command": "kit",
      "args": ["mcp"]
    }
  }
}
```

### Cursor

`.cursor/mcp.json` is already included in this repo. For other projects, add to `.cursor/mcp.json` in your project root:

```json
{
  "mcpServers": {
    "kit": {
      "command": "npx",
      "args": ["sandstream-kit", "mcp"]
    }
  }
}
```

### Windsurf / Cline

In Windsurf, open **Settings → MCP Servers** and add:

```json
{
  "kit": {
    "command": "npx",
    "args": ["sandstream-kit", "mcp"],
    "transport": "stdio"
  }
}
```

For Cline, add the same config to your `cline_mcp_settings.json`.

### Available MCP Tools

| Tool | Description |
|------|-------------|
| `kit_check` | Run all checks, return structured status JSON |
| `kit_install` | Install missing tools via mise |
| `kit_login` | Attempt service logins (non-interactive) |
| `kit_secrets` | Generate `.env.local` from configured sources |
| `kit_fix` | Auto-fix issues (install tools, generate lock files) |
| `kit_add` | Provision a service integration (stripe, supabase, etc.) |
| `kit_env` | Inspect `.env.local`, list keys with set/missing status and redacted values |

### Example: kit_check response

```json
{
  "ok": true,
  "tools": [
    { "name": "node", "required": "latest", "installed": "22.22.2", "ok": true }
  ],
  "secrets": [
    { "name": "APP_NAME", "source": "config", "available": true, "detail": "Derived from config" }
  ],
  "security": [
    { "category": "secrets", "name": ".env gitignored", "status": "pass", "detail": "all .env patterns in .gitignore" },
    { "category": "supply-chain", "name": "pinned versions", "status": "pass", "detail": "all dependencies pinned" }
  ],
  "locks": [
    { "category": "cli-lock", "exists": true, "inSync": true, "missing": [], "detail": "all tools locked" }
  ]
}
```

## Community & Support

### Getting Help

- 📚 **Plugin Development**: [docs/PLUGIN_DEVELOPMENT.md](docs/PLUGIN_DEVELOPMENT.md), [docs/ADAPTER_GUIDE.md](docs/ADAPTER_GUIDE.md), [docs/MCP_TOOLS_GUIDE.md](docs/MCP_TOOLS_GUIDE.md)
- 💬 **Discussions**: [github.com/sandstream/kit/discussions](https://github.com/sandstream/kit/discussions)
- 🐛 **Issues**: [github.com/sandstream/kit/issues](https://github.com/sandstream/kit/issues)
- 🤝 **Contributing**: [CONTRIBUTING.md](CONTRIBUTING.md), [COMMUNITY.md](COMMUNITY.md)

### Code of Conduct

See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Stack

- [mise-en-place](https://mise.jdx.dev): tool version management
- [1Password CLI](https://developer.1password.com/docs/cli/): secret management
- Node.js CLI (TypeScript)
