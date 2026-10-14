# kit

> One command from `git clone` to fully working dev environment.

For AI agents and humans. Manages tools, auth, secrets, and project setup. Zero LLM calls, local-first, multi-vault.

**Your standards, not ours.** kit ships zero opinions about your code or architecture — no bundled ruleset, no vendor's "best practice". You declare the standard (`.kit.toml` thresholds, your own plugin rules, architecture decisions as ADRs with enforce blocks); kit enforces the declaration deterministically and proves the checks ran. Taste may change: supersede the ADR, history keeps the why — and `kit baseline freeze` keeps day one honest by gating only net-new findings.

**kit** makes two promises concrete and keeps them across every major since 2.0: `green = honest` is externally _provable_ (kit can emit a signed receipt, anchored to a key its own process cannot recompute, proving which scanners actually ran and that none failed open, verifiable offline), and kit's CLI, config schema, and plugin SDK are frozen, versioned contracts that do not break across a major line. Since 5.0 it is a continuous, portable, fail-closed **governance layer for the agent loop**: hardware-rooted identity, an offline-verified control plane, one exec-broker enforcing a signed scope, and a traveling profile you can carry to a fresh host. See [What's new in 6.x](#whats-new-in-6x) and [Stability & contracts](docs/FEATURES.md#stability--contracts).

🌐 [sandstre.am/kit](https://sandstre.am/kit)

[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-support-FFDD00?logo=buymeacoffee&logoColor=black)](https://buymeacoffee.com/sandstream)

[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/sandstream/kit/badge)](https://securityscorecards.dev/viewer/?uri=github.com/sandstream/kit)
[![Security scan](https://github.com/sandstream/kit/actions/workflows/security.yml/badge.svg)](https://github.com/sandstream/kit/actions/workflows/security.yml)
[![Signed releases](https://img.shields.io/badge/releases-cosign%20signed-blue?logo=sigstore&logoColor=white)](#security-posture)
[![SBOM](https://img.shields.io/badge/SBOM-CycloneDX-brightgreen)](#security-posture)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## Quick start

**Prerequisites:** Node.js 22+, git, and [mise](https://mise.jdx.dev) for installing tools (`brew install mise`, or `curl https://mise.run | sh`).

**Platform support:** macOS, Linux, WSL2, Git Bash, and the core workflow on
native Windows. WSL2 remains the recommended Windows experience because several
edge tools still need POSIX utilities. Native verifier approvals use owner-only
Windows ACLs and run as a required Windows CI gate. See
[docs/PLATFORM_SUPPORT.md](docs/PLATFORM_SUPPORT.md).

```bash
# zero install (also sidesteps npm -g permission issues):
npx sandstream-kit setup

# or install globally:
npm i -g sandstream-kit
# if npm -g is permission-blocked, use a user-owned prefix instead of sudo:
#   npm config set prefix ~/.npm-global
#   echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc
```

### Run via Docker

Prefer a container (no local Node or mise)? The CLI ships as a signed image on
Docker Hub. Mount your project and point the workdir at it:

```bash
docker run --rm sandstream/kit:latest --version
docker run --rm -v "$PWD":/work -w /work sandstream/kit:latest check
```

Each release publishes `sandstream/kit` (version + `latest` tags), keyless-signed
with cosign and shipped with a CycloneDX SBOM. Verify the signature before
trusting an image:

```bash
cosign verify sandstream/kit:latest \
  --certificate-identity-regexp 'https://github.com/sandstream/kit/\.github/workflows/docker-build\.yml@.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

Then, in a repo:

```bash
kit init           # detect the stack → generate .kit.toml
kit check          # what's set up vs missing (tools, services, secrets, hooks, deploy, security)
kit setup          # install tools (via mise), git hooks, logins, secrets
kit context check  # lock each CLI to the declared account + project (no wrong-org pushes)
```

Fresh or ephemeral environment (cloud container, Claude Code on the web, CI, new
laptop)? Wire `kit setup` + `kit memory sync` into the environment's setup script
so it fuels itself — config, secrets (vault-backed), agent gates, identity, and
recall — with zero manual steps. See [docs/ENV_FUELING.md](docs/ENV_FUELING.md).

## What's new in 6.x

The 6.x line keeps every frozen contract from 5.0 and spends its effort on making each
verdict harder to fake. The releases that changed what kit does:

- **6.12: memory that travels, and a native Windows suite.** Encrypted backups move in
  independently authenticated 1 MiB frames and Git pulls stream long histories through a
  disk-backed index, so memory sync no longer holds a whole history in RAM.
  `kit memory project init` gives a repo one identity across clones. The full test suite
  runs natively on Windows in CI. `kit adr derive` proposes enforceable ADRs from the
  import graph, and every write-capable command is declared once and held to
  `--read-only`.
- **6.12.1: honest locks and a verified publish path.** `kit upgrade` refuses to write a
  lock whose installed version misses the declared pin, and `--version` answers in any
  position instead of running the command. Every package publishes over npm trusted
  publishing with provenance, and a test fails if a package is neither verified nor
  explicitly skipped.
- **6.11: the Monkey test release gate.** `kit monkey-test plan|init|run` checks a
  money app with a role-based Playwright crawl, a sandbox payment flow and security
  findings. See [docs/MONKEY_TEST.md](docs/MONKEY_TEST.md).
- **6.8 to 6.10: drift you can see.** Config drift is reported both ways, `[context]`
  can require the identity a repo must use, `kit tools list` inventories installed tools,
  new dependency debt fails while existing debt is baselined, and `kit usage` shows what
  kit knows and proves the floor still works.
- **6.7: the flag floor.** Every command rejects flags it does not accept, `kit audit
  verify --all` checks every audit log the machine sealed, and self-audit checks the
  documentation in both directions.

The 5.0 foundations (hardware-rooted identity, an offline-verified control plane, one
exec-broker enforcing a signed scope, and a traveling profile) are unchanged. See
[CHANGELOG.md](CHANGELOG.md) for every release, including 3.0 to 5.0.

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
- **kit orchestrates, it does not replace.** `kit check` runs the local scanners it
  finds (Semgrep, Trivy, osv-scanner, GuardDog); `kit scan` drives the wider registry
  (snyk/trivy/grype/semgrep/osv/socket) and merges it into one verdict; the `snyk` and
  `wiz` plugins ingest their findings; everything lands in one consolidated report next
  to kit's own checks, each with a remediation step. The cloud scanners (Snyk, Socket)
  run when their token is present and are dropped in air-gap mode — `kit setup` asks the
  network posture and points at where the tokens live (it never captures or stores them).
- **The one gate your agent runs.** Before an AI agent acts it runs `kit review` once
  and gets a single deterministic verdict across every source. No agent, no socket,
  no telemetry, zero LLM calls. Your code never leaves the machine.

Use kit **with** your scanners. It is the connective tissue that turns them into one
local-first, agent-native gate.

## Security posture

kit is a security tool, so it holds itself to the bar it sets. The receipts:

- **kit scans kit.** Every push runs CodeQL, Semgrep, Trivy, gitleaks, `npm audit`, OpenSSF
  Scorecard — and `kit check` itself (dogfooding) in CI.
- **Signed, attestable releases.** Docker images are keyless-signed with cosign and ship a
  CycloneDX **SBOM**; verify before trusting (see [Run via Docker](#run-via-docker)).
- **Coordinated disclosure.** Report a vulnerability via [SECURITY.md](SECURITY.md) — it
  carries the reporting path, a threat model + data-flow, an OWASP Top 10 assessment, and an
  incident-response plan with severity SLAs.
- **Secrets never live in the repo.** kit keeps credentials in a vault, materializes
  `.env.local` locally (gitignored), and scans code, staged diffs, git history and its own
  memory store for leaked keys. A stolen _repo_ should contain no live secrets.
- **Supply chain is gated, not trusted.** `kit triage` runs before any install — fail-closed,
  "installs nothing untriaged" (aligns with OpenSSF S2C2F).
- **Green you can prove.** `kit scan`'s verdict accounts for scanner _health_, not just findings, so
  a crashed, missing, or token-less scanner can no longer exit 0 silently (opt in to a hard fail with
  `kit ci --strict` or `[governance.scan].required_scanners`). `kit check --attest` writes a signed
  receipt of which scanners actually ran plus the verdict, sealed with a machine-local anchor key; the
  `.kit-audit.jsonl` chain can be sealed with `kit audit anchor`. Honest scope: the anchor raises
  forgery from "anyone who can write the log" to "someone who can read the `0600` key", it is **not**
  tamper-proof against a same-UID local principal (that needs the documented external TSA anchor).
- **Local-first, zero LLM, no telemetry.** Your code never leaves the machine.

> At-rest note: kit's local memory store (`~/.kit/memory.db`, `0600`) relies on OS full-disk
> encryption (FileVault / LUKS / BitLocker) today; application-level at-rest encryption is
> tracked as a follow-up.

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
# Choosing a vault wires it up: kit adds its CLI to [tools] so `kit setup` installs
# it via mise (1password, infisical, doppler, bitwarden, vault), then guides login.
# Cloud secret managers (aws-sm, gcp-sm, azure-kv) are an exception — see below.
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
- `kit check`: Status of tools, services, secrets, hooks, deploy env, security, tests
- `kit fix`: Auto-remediate gaps (tools, gitignore, hooks, .env.template, declared deploy env) and print HITL blocks for auth / DSN setup
- `kit review` / `kit heal`: One-gate repo audit (check + design + standards + ADR + skill discipline); bounded self-heal loop
- `kit adr {check,list,freeze}`: Turn an Architecture Decision Record into a deterministic gate — enforce a `kit-enforce` block (`forbid_pattern` / `require_pattern` / `forbid_import`, incl. transitive and across npm package boundaries) cited back to the ADR. Zero-LLM (prose is never interpreted)
- `.kit/standards.d/*.toml`: Declarative house-rule plugins support `mode = "forbid"` and `mode = "require"`; directory excludes like `scripts/` mean `scripts/**`, with zero-match warnings
- `kit scan`: Run external scanners (snyk/trivy/grype/semgrep/osv/socket) → one merged, air-gap-aware verdict
- `kit supply-chain` / `kit sbom` / `kit gha-audit` / `kit agent-audit`: Install-time triage, SBOM, Actions hardening, agent/MCP/hook audit
- `kit self-audit`: Deterministic self-check of kit's own source against the audit's bug-classes (also asserts CI-referenced scripts exist)
- `kit coverage [--standard=<key>|all]`: Evidence maps against 8 pinned standards — OWASP **ASVS L2** · **LLM Top 10** · **Agentic Top 10** · **MCP Top 10** · NIST **SSDF 800-218A** · **NIST 800-53 Rev. 5** (control-family level) · **AIUC-1** · **GCP WAF Security** — showing which controls kit's deterministic checks auto-verify vs gap/manual/n-a (evidence maps, **not** compliance attestations; `--list-standards` to enumerate, `--json` for GRC tools)
- `kit sentinel {run,install,status}`: Autonomous redline watcher (propose/apply guarded fixes)
- `kit verify-provenance` / `kit ingest`: Verify SLSA provenance offline; ingest external SARIF/OSV
- `kit login --plan`: Show the resolved auth strategy (vault/capture/interactive) per service without logging in
- `kit secrets {set,migrate,rotate,propagate,onecli,validate}`: Secret lifecycle
- `kit memory {index,search,stats,suggest,merge,save,threads,share,backup}`: Local-first, cross-harness second brain (per-harness `stats`, project recall, saved copilots) + `kit memory pal` pending-action ledger
  - **Classified memory** — *partially wired, and this line says so rather than implying more.* Every memory row carries a sensitivity class column, and the disclosure logic is implemented and unit-tested: recall filters to classes no more restrictive than the asking context, a missing or unrecognized class is excluded from **every** context (fail-closed), and an invalid configured value resolves to `restricted` rather than silently widening disclosure. **What is not connected yet:** no call site supplies the per-project class or the recall context, so every row currently takes the built-in default (`internal`) and the configured/environment override is inert. Until that wiring lands, do not rely on this to keep a note out of another project — see the `documented env vars` check in `kit self-audit`, which is what caught it.
- `kit auth {elevate,setup-totp,status,revoke}`: Elevation gate + TOTP
- `kit mcp {list,auth,set-token,clear}`: MCP-server orchestrator
- `kit env {list,switch,current,diff}`: Environment routing + drift detection
- `kit context {check,use,--prompt}`: Lock each CLI to its declared account + project (no wrong-org pushes)
- `[agent_config.user_rules]`: Per-repo opt-in to inject user-level prose from one file/directory into all managed agent rules files, capped by line/byte limits
- `kit triage {npm,pip,docker,repo,skill}`: Pre-install security check
- `kit security {scan-build,scan-staged,scan-artifact,verify-pull,costs,policy}`: Security ops; `scan-artifact <path>` is the ingestion gate for an untrusted file/tree (ClamAV delegate — malicious **or** an unverifiable gap both fail)
- `.kit-secretsignore`: Accept a reviewed secret finding by name (`<commit>:<file>:<detector>`, one per line). History is immutable, so a fixture committed once is a finding forever and the scan sits at `warn` permanently — a warning with no reachable green state is one nobody reads. Two properties keep it safe: an entry names **one commit**, so it can never wave through a future occurrence of the same string, and a **verified-live** finding is never ignorable regardless of what is listed
- `kit hooks {install,add,sync}`: Git hooks + bypass detector
- `kit governance` / `kit audit {secrets,verify,anchor,export}`: Policy + audit-log inspection; `anchor`/`verify` seal and check the external HMAC anchor
- `[policy.agent_writes]`: Declares which vendor writes are pre-approved — **enforced** since 6.3.2 at kit's own choke points (`propagate()`, secret rotation) and since 6.4.0 inside the `kit-plugin-*` packages, which receive the resolved decision as an exported deny list and never see your config. It only ever **narrows**: the block is unsigned config anyone who can edit the repo — including an agent — could add a line to, so declaring an op never *satisfies* elevation, read-only or signed approval (`.kit-policy.toml` + `kit policy approve` are the grant-shaped mechanism, and require an org signature). An empty list is a lock, not a wildcard; every grant and refusal is audited with vendor, op, state and policy hash. See [`docs/POLICY.md`](./docs/POLICY.md)
- `kit check --attest` (also `kit ci --attest` / `KIT_ATTEST=1`): Opt-in signed receipt of which scanners ran + the verdict; `kit check verify-attestation <file>` verifies it
- `kit check compare <before.json> <after.json>`: Run-to-run diff of two `--json` runs — what actually changed since the last scan, which a baseline cannot tell you (freezing suppresses, it does not compare). **Lost coverage outranks a regression**: `fail → skip` means the check stopped running, so the finding is *unknown*, not fixed — a naive differ would call that an improvement. `--fail-on-worse` gates CI on the delta instead of the absolute verdict
- `kit config migrate`: Migrate a versioned `.kit.toml` to the current schema (`--dry-run` default, auto-backup, re-validate-or-restore, `--check` for CI)
- `kit airgap verify`: Prove every scanner that would run in air-gap mode resolves to a local artifact (no egress)
- `kit browser {doctor,status,cdp-url,playwright-env}`: Which browser strategy a repo actually gets for verification — Playwright, system Chrome, or CDP — or the blocker in the way, plus the exports to wire a test runner (`--json` on each). kit owns local browser diagnostics, not app start
- `kit --read-only <subcommand>`: Refuses project and provider writes; local `~/.kit` memory state may still be initialized by read commands

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
_use_ kit, it writes a small managed "run kit check / triage before install /
vault your secrets" block into the agent's rules file (`CLAUDE.md`, `AGENTS.md`,
`.cursorrules`, `.clinerules`). Run it standalone any time with `kit agent-config`.
The block is regenerated in place on re-run; edit outside its markers freely.

## Agent support

kit wires the same gates into every supported agent harness. The full reference (secrets,
deploy env matrix, scanners, self-audit, git hooks, environments and elevation, context lock,
quality gates, supply chain, shell guard, compliance evidence, stability contracts) is in
[docs/FEATURES.md](docs/FEATURES.md#agent-support-and-features).

## Memory

`kit memory` gives an agent a local-first, deterministic second brain, it stores
your raw conversation history and searches it _before answering_, so it pulls
receipts instead of guessing. SQLite + FTS5, three lifecycle events per supported
hook harness, no vectors, no model calls.
It indexes transcripts from **twelve** coding agents (Claude Code, Codex, Gemini,
Continue, Cursor, Amazon Q, AWS Kiro, Factory Droid, Aider, Antigravity, Cline, and
OpenCode), each parsed against the agent's own serialization format, never guessed. A private personal tier (encrypted backup so a
stolen laptop doesn't lose your context, plus opt-in **cross-device sync** — your
own git remote or command, ciphertext-only, with a public-key mode so even a
throwaway cloud session can contribute with no secret) plus a curated,
area-organized **shared** tier that travels with the repo and is reviewed like code.

```bash
kit memory install && kit memory index
kit memory search "what did we decide about X"   # project-scoped recall
kit memory area stripe                            # shared: how we built it, status, security
kit memory suggest | your-llm                     # zero-LLM core; pipe a review prompt to YOUR model
```

Full reference: [`docs/MEMORY.md`](docs/MEMORY.md). Original schema + hook design
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

`kit add <service>` provisions a declared service and fuels its env vars into your vault. How it
works, the service catalogue and example workflows are in
[docs/FEATURES.md](docs/FEATURES.md#service-provisioning).

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

### The one-line agent bootstrap

The fastest adoption path needs no human setup at all: paste ONE line into the
repo's `CLAUDE.md` / `AGENTS.md` (or your global agent rules) and the next
agent session bootstraps kit itself — install, init, verify — and asks the
human only for what is genuinely theirs (interactive logins):

```markdown
This project uses kit (github.com/sandstream/kit). If `kit` is missing: `npm i -g sandstream-kit`, then `kit init` (detects the stack, generates .kit.toml, wires agent config + install gates). Start every session with `kit check` and act on its verdict; `kit fix` auto-repairs; interactive steps like `kit login` belong to the human — suggest they run them (in Claude Code: prefix with `!` so the output lands in the session). `kit <command> --help` self-documents.
```

What the agent does from that line: installs kit globally, runs `kit init`
(which also writes the managed "use kit" block into the rules file — the
one-liner retires itself), runs `kit check`, and walks the human through the
gaps. Trust note: this first install is your trust root — kit can't triage its
own bootstrap. Releases carry SLSA provenance and cosign-signed images; see
[docs/VERIFY.md](docs/VERIFY.md) to verify before you paste the line into an
org-wide template.

**Transparent end state** — you should know exactly what a line you paste
will turn into. When the bootstrap completes, your rules file contains this
managed block and nothing else has been touched (visible BEGIN/END markers,
idempotent — re-runs update only the region between them):

```markdown
<!-- BEGIN kit (managed block — edit outside the markers, not inside) -->
## kit

This repo is managed by [kit](https://github.com/sandstream/kit) (env, secrets, security gates). Hooks enforce the hard rules; what you need to know:

- If `kit` is missing (fresh clone/machine): `npm i -g sandstream-kit`, then continue below.
- Start: `kit check` — on `fail`, run `kit fix`, then re-check.
- Prior decisions: `kit memory search "<query>"` (cross-session, cross-agent).
- Secrets: `kit secrets` (vault-backed); placeholders go in `.env.example`, never plaintext in `.env*`.
- Deploy env: `[deploy]` declares required platform key names; `kit check --category deploy` diffs remote names without reading values.
- Deps the install gate hasn't covered (git repos, URLs, vendored code): `kit triage repo <target>` first.
- After a batch of edits: `kit check --category security`; halt and surface findings on `fail`.
- Everything else: `kit --help` — the commands are self-documenting.
<!-- END kit -->
```

The block is an index, not an encyclopedia — every agent turn pays for these
tokens, so anything a hook already enforces deterministically carries zero
prose here. A drift test pins this README example to the `KIT_INSTRUCTION`
the code actually writes, so the promise can't rot.

kit exposes its capabilities as an MCP server, making it usable directly by Claude Code, Cursor, Windsurf, Cline, and any other MCP-compatible AI assistant. Once registered, assistants can call `kit_check`, `kit_fix`, `kit_triage`, and other tools without leaving their context. (An agent **with shell access** should prefer the CLI — zero standing context cost, and `kit <command> --help` self-documents; the MCP surface exists for shell-less clients. The server's `instructions` field tells clients exactly this.)

### ChatGPT web

Run `kit mcp web` in an interactive terminal. Its six-stage wizard connects the
existing local stdio server through
[OpenAI Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels):
no inbound port and no public kit endpoint. It verifies `tunnel-client`, opens
the exact Platform and ChatGPT pages, configures `kit mcp`, runs `doctor`, and
starts the tunnel. The runtime API key stays in process memory; keep the durable
copy in your vault. Native Windows operators need Git Bash or WSL for the wizard.

This path is specifically for ChatGPT web. Claude Code uses local stdio below;
kit does not expose a public remote HTTP endpoint for claude.ai connectors.

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

| Tool            | Description                                                                                     |
| --------------- | ----------------------------------------------------------------------------------------------- |
| `kit_check`     | Run all checks, return structured status JSON                                                   |
| `kit_review`    | Full repo audit — check + design + standards + ADR + skill gates as one structured report              |
| `kit_fix`       | Auto-fix issues (install tools, generate lock files)                                            |
| `kit_triage`    | Security-triage a dependency BEFORE installing it — a pass satisfies the install gate           |
| `kit_memory`    | Search cross-session memory + the repo's curated shared decisions (search-only)                 |
| `kit_secrets`   | Generate `.env.local` from configured sources (returns key names, never values)                 |
| `kit_run`       | Run a command with the secret-loaded env — escape hatch for every other kit command             |
| `kit_context`   | Gather project context (stack, services, env status)                                            |
| `kit_map`       | Repo map: import-neighborhood slice around seed paths                                           |
| `kit_init`      | Detect the stack and generate `.kit.toml` (dry-run supported)                                   |

Full reference: [docs/MCP_TOOLS_REFERENCE.md](docs/MCP_TOOLS_REFERENCE.md) · usage guide: [docs/MCP_TOOLS_GUIDE.md](docs/MCP_TOOLS_GUIDE.md)

### Example: kit_check response

```json
{
  "ok": true,
  "tools": [{ "name": "node", "required": "latest", "installed": "22.22.2", "ok": true }],
  "secrets": [
    { "name": "APP_NAME", "source": "config", "available": true, "detail": "Derived from config" }
  ],
  "security": [
    {
      "category": "secrets",
      "name": ".env gitignored",
      "status": "pass",
      "detail": "all .env patterns in .gitignore"
    },
    {
      "category": "supply-chain",
      "name": "pinned versions",
      "status": "pass",
      "detail": "all dependencies pinned"
    }
  ],
  "locks": [
    {
      "category": "cli-lock",
      "exists": true,
      "inSync": true,
      "missing": [],
      "detail": "all tools locked"
    }
  ]
}
```

## Community & Support

### Getting Help

- 📚 **Plugin Development**: [docs/PLUGIN_DEVELOPMENT.md](docs/PLUGIN_DEVELOPMENT.md), [docs/ADAPTER_GUIDE.md](docs/ADAPTER_GUIDE.md), [docs/MCP_TOOLS_GUIDE.md](docs/MCP_TOOLS_GUIDE.md)
- 🔤 **Acronyms & terms**: [docs/GLOSSARY.md](docs/GLOSSARY.md) — what SBOM, MCP, PAL, SLSA, … mean in kit
- 📐 **Standards coverage & gaps**: [docs/STANDARDS.md](docs/STANDARDS.md) — which security standards kit maps to (OWASP, ASVS, SLSA, …) and which it doesn't yet
- 🧭 **What kit is**: [docs/ENFORCEMENT_AND_AUDIT.md](docs/ENFORCEMENT_AND_AUDIT.md) — kit as both a deterministic enforcement "grinder" and an audit tool, and the "no false green" loop between them
- 💬 **Discussions**: [github.com/sandstream/kit/discussions](https://github.com/sandstream/kit/issues)
- 🐛 **Issues**: [github.com/sandstream/kit/issues](https://github.com/sandstream/kit/issues)
- 🤝 **Contributing**: [CONTRIBUTING.md](CONTRIBUTING.md), [COMMUNITY.md](COMMUNITY.md)

### Support

kit is free and MIT-licensed. If it saved you setup time or caught a leak before it shipped, you can [buy me a coffee](https://buymeacoffee.com/sandstream). It funds development time and keeps kit free and open.

### Code of Conduct

See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Stack

- [mise-en-place](https://mise.jdx.dev): tool version management
- [1Password CLI](https://developer.1password.com/docs/cli/): secret management
- Node.js CLI (primarily TypeScript; JavaScript tooling/scripts, plus a Python triage checker)

## Acknowledgements

kit is its own codebase, but several projects shaped how we approached specific
problems. We studied them and borrowed ideas and design patterns — the
implementations here are kit's own (deterministic, zero-LLM). Thanks to:

- **[cloudctx](https://github.com/chadptk1238/cloudctx)** (MIT) — the memory
  store's SQLite schema and two-hook capture design.
- **[headroom](https://github.com/chopratejas/headroom)** — the idea behind
  `kit memory learn`: mine transcripts for recurring instructions and _suggest_
  memory rules (kit does it deterministically, bring-your-own-LLM, no model call).
- **[guild](https://github.com/mathomhaus/guild)** (Apache-2.0) — atomic PAL
  ("blocked-on-you") claiming: claim/release with auto-release of abandoned
  claims, so parallel agents don't collide on the same item.
- **[veto](https://github.com/PlawIO/veto)** (Apache-2.0) — expressing
  allow/deny/approval decisions declaratively and proving guarantees with a
  checked-in baseline enforced in CI; echoed in kit's gated, fail-closed checks.
- **[aigis](https://github.com/killertcell428/aigis)** (Apache-2.0) — the
  tamper-evident audit trail and a reproducible findings shape, and the idea of
  filtering memory writes against prompt injection.

We also learned from peers in the zero-LLM agent-safety and dev-tooling space —
including [sentrux](https://github.com/sentrux/sentrux),
[rtk](https://github.com/rtk-ai/rtk), and
[depgraph-cli](https://github.com/synthesiseng/depgraph-cli) — even where kit
hasn't (yet) drawn code or patterns from them.
