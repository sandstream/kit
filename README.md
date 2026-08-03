# kit

> One command from `git clone` to fully working dev environment.

For AI agents and humans. Manages tools, auth, secrets, and project setup. Zero LLM calls, local-first, multi-vault.

**Your standards, not ours.** kit ships zero opinions about your code or architecture — no bundled ruleset, no vendor's "best practice". You declare the standard (`.kit.toml` thresholds, your own plugin rules, architecture decisions as ADRs with enforce blocks); kit enforces the declaration deterministically and proves the checks ran. Taste may change: supersede the ADR, history keeps the why — and `kit baseline freeze` keeps day one honest by gating only net-new findings.

**kit** makes two promises concrete and keeps them across every major since 2.0: `green = honest` is externally _provable_ (kit can emit a signed receipt, anchored to a key its own process cannot recompute, proving which scanners actually ran and that none failed open, verifiable offline), and kit's CLI, config schema, and plugin SDK are frozen, versioned contracts that do not break across a major line. **kit 5.0** turns the provable local floor into a continuous, portable, fail-closed **governance layer for the agent loop** — hardware-rooted identity, an offline-verified control plane, one exec-broker enforcing a signed scope, and a traveling profile you can carry to a fresh host. See [What's new in 5.0](#whats-new-in-50) and [Stability & contracts](#stability--contracts).

🌐 [sandstre.am/kit](https://sandstre.am/kit)

[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-support-FFDD00?logo=buymeacoffee&logoColor=black)](https://buymeacoffee.com/sandstream)

[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/sandstream/kit/badge)](https://securityscorecards.dev/viewer/?uri=github.com/sandstream/kit)
[![Security scan](https://github.com/sandstream/kit/actions/workflows/security.yml/badge.svg)](https://github.com/sandstream/kit/actions/workflows/security.yml)
[![Signed releases](https://img.shields.io/badge/releases-cosign%20signed-blue?logo=sigstore&logoColor=white)](#security-posture)
[![SBOM](https://img.shields.io/badge/SBOM-CycloneDX-brightgreen)](#security-posture)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## Quick start

**Prerequisites:** Node.js 22+, git, and [mise](https://mise.jdx.dev) for installing tools (`brew install mise`, or `curl https://mise.run | sh`).

**Platform support:** macOS, Linux, and Windows **via [WSL2](https://learn.microsoft.com/windows/wsl/install) or Git Bash**. Native Windows (PowerShell/cmd) is not supported yet — kit's git hooks, tool resolution, and secret-file permissions assume a POSIX shell. On Windows, run kit from inside a WSL2 distro (recommended) or Git Bash. See [docs/PLATFORM_SUPPORT.md](docs/PLATFORM_SUPPORT.md).

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
kit check          # what's set up vs missing (tools, services, secrets, hooks, security)
kit setup          # install tools (via mise), git hooks, logins, secrets
kit context check  # lock each CLI to the declared account + project (no wrong-org pushes)
```

Fresh or ephemeral environment (cloud container, Claude Code on the web, CI, new
laptop)? Wire `kit setup` + `kit memory sync` into the environment's setup script
so it fuels itself — config, secrets (vault-backed), agent gates, identity, and
recall — with zero manual steps. See [docs/ENV_FUELING.md](docs/ENV_FUELING.md).

## What's new in 5.0

kit 5.0 takes kit from a point-in-time verifier
to a _continuous, portable, fail-closed governance layer_ for the agent loop.
Four pillars, all additive over 4.x — no stable command removed. Highlights:

- **Pillar 1 — hardware-rooted identity.** `kit doctor` surfaces which backend
  signs kit's identity (Secure Enclave / TPM / external command vs. a file-backed
  0600 key) and never silently downgrades; `KIT_REQUIRE_HARDWARE_IDENTITY` makes a missing
  hardware backend fail-closed. `kit identity migrate` moves onto hardware and
  revokes the old key in one audited step.
- **Pillar 2 — control plane.** `kit policy pull` / `pull-revocations` distribute an
  org-signed policy, verified and enforced fully offline; `kit policy approve` mints
  offline signed approval tokens. **Keyless egress signing is not shipped:** the RFC 9421
  HTTP Message Signature primitives exist and are tested (`src/keyless/`), and `[scope].sign`
  is a real signed field that `kit doctor` reports on (declared vs verified) — but nothing
  imports `src/keyless/` outside itself, so no request on the egress path is ever signed.
  This entry previously described it in the present tense.
- **Pillar 3 — one exec-broker.** A single signed-scope governance floor drives
  the PreToolUse gates (`kit gate-egress` / `gate-fs`), the MCP runtime, and the
  `kit doctor` posture. Runtime mediation is **on by default in observe mode**
  (audits what it _would_ deny); enforce is an explicit opt-in.
- **Pillar 4 — traveling profile.** `kit profile` declares your
  `{skills, mcp, workflows, plugins, vault, gates, scope}`, audits
  declared-vs-discovered drift, signs the scope/RoE, and **exports/imports** a
  portable signed bundle to a fresh host — integrity-verified offline,
  fail-closed on tamper.
- **Deep skill triage.** `kit triage skill --deep` delegates to NVIDIA
  SkillSpector's static Stage 1 (no LLM, no egress) and `kit setup --recommended`
  wires the triage gates into your pre-commit hook.
- **Repo-map (`kit map` / MCP `kit_map`).** A deterministic, zero-LLM code map:
  given a seed file, get the relevant _slice_ of the repo — import neighbors
  (TS/JS + Python), a `--budget` cap with a logged drop-list, owner attribution
  (CODEOWNERS or git-blame), and `--co-change` coupling from git history — so an
  agent loads part of a growing repo, not the whole tree.

All of it holds the frozen CLI / config / plugin contracts. See
[CHANGELOG.md](CHANGELOG.md) for the full list.

## What's new in 3.0

kit 3.0 takes it from a provable local floor to an **org-governed control plane** —
identity + policy is the contract. All additive over 2.x (no stable command
removed; enforced by a public-surface invariant). Highlights:

- **Identity + signable policy.** A local Ed25519 `kit identity`, a signable,
  distributable **`.kit-policy.toml`** (policy-as-code) any kit verifies offline
  before enforcing, and a committed **org trust anchor** (`.kit-policy.signers`).
  `kit panic` rotates + emits a signed revocation.
- **Governed cross-device memory.** `kit memory push`/`pull` sync your private
  store over **your own** encrypted transport — a private git remote or any
  `transport = "command"` (S3/rclone/scp/USB). Configurable without a backdoor:
  local-only config, remote ≠ project origin, AES-256-GCM payload, opt-in.
  `kit memory sync init` scaffolds it; opt-in auto pull-on-start / push-on-end
  makes ephemeral containers durable. PAL action items are **device-coupled** so
  a throwaway session never nags your laptop, and `kit memory install` wires the
  status-line so the "blocked-on-you" count is visible.
- **Tamper-evident, attributable audit.** The HMAC anchor now binds attribution
  (`kid`/`sig`) into the seal — stripping or forging the signer of a sealed entry
  is caught (anchor v3).
- **Hardened gate.** Closed install-gate bypasses (env-prefix, `npm exec`/`dlx`,
  remote tarballs, subshells), two ReDoS, and a policy-canonicalization gap.
- **Smart, zero-LLM UX.** Deterministic `💡 tip:` hints surface the right
  capability at the right moment, and **`kit config knobs`** lists the power-user
  env/config knobs.

See [CHANGELOG.md](CHANGELOG.md) for the full 3.0.0 entry.

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
- `kit check`: Status of tools, services, secrets, hooks, security, tests
- `kit fix`: Auto-remediate gaps (tools, gitignore, hooks, .env.template)
- `kit review` / `kit heal`: One-gate repo audit (check + design + standards + ADR); bounded self-heal loop
- `kit adr {check,list,freeze}`: Turn an Architecture Decision Record into a deterministic gate — enforce a `kit-enforce` block (`forbid_pattern` / `require_pattern` / `forbid_import`, incl. transitive and across npm package boundaries) cited back to the ADR. Zero-LLM (prose is never interpreted)
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
- `kit triage {npm,pip,docker,repo,skill}`: Pre-install security check
- `kit security {scan-build,scan-staged,scan-artifact,verify-pull,costs,policy}`: Security ops; `scan-artifact <path>` is the ingestion gate for an untrusted file/tree (ClamAV delegate — malicious **or** an unverifiable gap both fail)
- `kit hooks {install,add,sync}`: Git hooks + bypass detector
- `kit governance` / `kit audit {secrets,verify,anchor,export}`: Policy + audit-log inspection; `anchor`/`verify` seal and check the external HMAC anchor
- `kit check --attest` (also `kit ci --attest` / `KIT_ATTEST=1`): Opt-in signed receipt of which scanners ran + the verdict; `kit check verify-attestation <file>` verifies it
- `kit check compare <before.json> <after.json>`: Run-to-run diff of two `--json` runs — what actually changed since the last scan, which a baseline cannot tell you (freezing suppresses, it does not compare). **Lost coverage outranks a regression**: `fail → skip` means the check stopped running, so the finding is *unknown*, not fixed — a naive differ would call that an improvement. `--fail-on-worse` gates CI on the delta instead of the absolute verdict
- `kit config migrate`: Migrate a versioned `.kit.toml` to the current schema (`--dry-run` default, auto-backup, re-validate-or-restore, `--check` for CI)
- `kit airgap verify`: Prove every scanner that would run in air-gap mode resolves to a local artifact (no egress)
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
_use_ kit, it writes a small managed "run kit check / triage before install /
vault your secrets" block into the agent's rules file (`CLAUDE.md`, `AGENTS.md`,
`.cursorrules`, `.clinerules`). Run it standalone any time with `kit agent-config`.
The block is regenerated in place on re-run; edit outside its markers freely.

## Agent support

kit is **agent-agnostic** — it's a CLI that any coding agent can run, plus opt-in
adapters for the surfaces each agent exposes. Support today, per agent:

| Agent             | Memory index¹ |    "use kit" rules block²    |         Agent/MCP config audit³         | Perm allowlist⁴ | Auto-capture hooks⁵ | Blocking gate⁶ |
| :---------------- | :-----------: | :--------------------------: | :-------------------------------------: | :-------------: | :-----------------: | :------------: |
| **Claude Code**   |      ✅       |        ✅ `CLAUDE.md`        |   ✅ + commands/agents/skills/plugins   |       ✅        |         ✅          |    ✅ hook     |
| **OpenAI Codex**  |      ✅       |        ✅ `AGENTS.md`        |           ✅ `.codex/config`            |        —        |          —          |    ✅ hook     |
| **OpenCode**      |      ✅       |        ✅ `AGENTS.md`        | ✅ `opencode.json` + `.opencode/plugin` |        —        |          —          |   ✅ plugin    |
| **Cursor**        |      ✅       |      ✅ `.cursorrules`       |          ✅ `.cursor/mcp.json`          |        —        |          —          |    ✅ hook     |
| **Cline**         |      ✅       |       ✅ `.clinerules`       |                    —                    |        —        |          —          |    ✅ hook     |
| **Copilot**       |       —       | ✅ `copilot-instructions.md` |                    —                    |        —        |          —          |       —⁸       |
| **Gemini CLI**    |      ✅       |        ✅ `GEMINI.md`        |                    —                    |        —        |          —          |    ✅ hook     |
| **Continue**      |      ✅       |              —               |                    —                    |        —        |          —          |      n/a⁷      |
| **Amazon Q**      |      ✅       |              —               |                    —                    |        —        |          —          |    ✅ hook     |
| **AWS Kiro**      |      ✅       |   ✅ `AGENTS.md` (shared)    |                    —                    |        —        |          —          |    ✅ hook     |
| **Factory Droid** |      ✅       |   ✅ `AGENTS.md` (shared)    |                    —                    |        —        |          —          |    ✅ hook     |
| **Aider**         |      ✅       |              —               |                    —                    |        —        |          —          |       —        |
| **Antigravity**   |      ✅       |              —               |                    —                    |        —        |          —          |    ✅ hook     |
| **Augment**       |       —       |   ✅ `.augment-guidelines`   |                    —                    |        —        |          —          |    ✅ hook     |

✅ supported · — not yet · n/a not applicable (no surface) ([#146](https://github.com/sandstream/kit/issues/146))

1. `kit memory index` parses the agent's local transcripts into the shared store.
2. `kit agent-config` writes the managed "run kit before installs / vault secrets" block into the agent's rules file.
3. `kit agent-audit` flags plaintext secrets, cleartext/inline-code MCP servers, and malware-shaped hooks in the agent's config. Generic `.mcp.json` / `.claude.json` are scanned for every agent regardless.
4. kit can pre-authorize its read-only commands so they run without a prompt (Claude Code's `permissions.allow` today).
5. kit registers lifecycle hooks so memory capture happens automatically (Claude Code `settings.json` hooks today).
6. A **true blocking gate** (deny an un-triaged install before it runs) uses the agent's pre-tool hook — `kit agent-config` wires it by default (`--no-install-gate` opts out) for Claude Code, Codex, Amazon Q, Gemini CLI, and Cursor (exit-2 hook commands); AWS Kiro, Factory Droid, Augment, and Antigravity via their hook/settings files (`.kiro/agents`, `.factory/hooks.json`, `.augment/settings.json`, `.agents/hooks.json`); OpenCode via a generated `.opencode/plugin` that hooks `tool.execute.before` and throws; and Cline via an executable `.clinerules/hooks/PreToolUse` shim that blocks through Cline's `{cancel:true}` stdout contract — **11 agents** in all. The agent-agnostic enforcement floor is **git hooks** (`kit hooks`, pre-commit/pre-push) — they fire in any agent or none. See [#146](https://github.com/sandstream/kit/issues/146).
7. **Continue** exposes only a declarative tool-permission policy (`~/.continue/permissions.yaml` allow/ask/exclude) with no way to invoke an external command before a tool runs, so a kit blocking-gate adapter isn't possible there — git hooks + the rules-file block remain its floor.
8. **GitHub Copilot** (VS Code / Visual Studio): the "use kit" rules block is written to `.github/copilot-instructions.md` (wired when a `.vscode/` dir is present or the file already exists). Memory indexing and a blocking install-gate are not yet implemented — they need Copilot's transcript format and a pre-tool-hook surface verified against primary sources first. The git-hook floor + the MCP server (`kit mcp`, added to `.vscode/mcp.json`) apply today.

> The git-hook layer enforces at the VCS boundary regardless of agent; the rules-file block is **advisory** (it reminds the agent); only the blocking-gate hook **enforces** before an action runs.

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
release-verification in [`docs/VERIFY.md`](./docs/VERIFY.md). kit's verdicts are
produced by deterministic code, never an LLM — a CI-enforced contract, see
[`docs/ZERO_LLM_CONTRACT.md`](./docs/ZERO_LLM_CONTRACT.md).

- `kit doctor`: Deep diagnostics: Node.js version, mise, .env.local, tools in PATH, git hooks, and **OS containment posture** — detects the sandbox *below* the tool boundary (container / seccomp / user-ns, and gVisor / Firecracker fingerprints) and reports it honestly (`unknown` on non-Linux, never a false "not contained"). Set `[governance.containment] require = true` to make it a **fail-closed gate**: doctor fails when containment can't be positively established (including when it can't be determined). kit detects/verifies a sandbox — it never becomes one
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

**Which vault CLIs kit installs.** When you pick a secret backend at `kit init`, kit
provisions its CLI like any other tool — it adds the CLI to `[tools]`, so `kit setup`
installs it via mise, resolves it mise-first at read time, and prints the login step.
This covers the dedicated vault CLIs:

| Backend             | CLI installed by `kit setup`?            | Authenticate with                    |
| ------------------- | ---------------------------------------- | ------------------------------------ |
| 1Password           | yes (`op` via mise)                      | `op signin`                          |
| Infisical           | yes (`infisical` via mise)               | `infisical login` + `infisical init` |
| Doppler             | yes (`doppler` via mise)                 | `doppler login` + `doppler setup`    |
| Bitwarden           | yes (`bw` via mise)                      | `bw login` + `bw unlock`             |
| HashiCorp Vault     | yes (`vault` via mise)                   | `vault login`                        |
| AWS Secrets Manager | **no** — uses your existing `aws` CLI    | `aws configure` / IAM role           |
| GCP Secret Manager  | **no** — uses your existing `gcloud` CLI | `gcloud auth login`                  |
| Azure Key Vault     | **no** — uses your existing `az` CLI     | `az login`                           |

The three cloud secret managers are a deliberate exception: their CLIs are normally
already present (cloud installer, CI image, IAM environment), authenticate through
cloud-native mechanisms rather than a CLI login, and a second mise-managed copy could
shadow the system one. kit therefore **guides** their login but does not install the
CLI — it resolves the binary from your `PATH` and falls back cleanly if absent. Logging
in to any vault is always your own account action; kit never does it for you.

### Security scanners

- `kit security scan-staged`: Pre-commit: scan staged blobs for known credential patterns
- `kit security scan-build`: Walk `.next/`, `dist/`, `build/` for credentials inlined into artifacts (`NEXT_PUBLIC_` typos)
- `kit security scan-transcripts`: Walk `.claude/`, `~/.claude/projects/`, `.opencode/` for replayed-secret leaks
- `kit security check-gitignore [--fix]`: Verify `.env*`, `*.pem`, `id_rsa`, `.kit/elevation.json` are ignored
- `kit security verify-pull [--base <ref>]`: After `git pull`: audit new deps, gitignore drops, introduced secrets, policy changes
- `kit security policy [init|add <pkg>|check]`: Dependency allowlist enforcement + per-key spend caps/TTL/scope
- `kit security costs`: Snapshot per-key spend vs policy cap (Stripe live; OpenAI/Anthropic/Resend/Vercel stubbed)
- `kit security clear-cache`: Reset the cached supply-chain scanner binary (use after an intentional rebuild)

### Self-audit

`kit self-audit` runs kit against its own source. It is zero-LLM and deterministic (walks `src/*.ts`, no network), so it can gate in CI. Two jobs in one: it scans for the same bug-classes the wider audit catches (reintroduced `|| true`, unguarded dynamic imports, and the rest of the rule set), and it asserts that every script referenced from `.github/workflows/*.{yml,yaml}` (node/python files, `npm run` targets) actually exists, so a workflow can never point at a missing script.

- `kit self-audit`: Run every enabled rule; print findings (text by default; `--format=github` / `--format=gitlab` / `--format=json` for CI)
- `kit self-audit --list-rules`: Print the rule list (id, detection-class, severity) without running
- `kit self-audit --only <rule-id,...>`: Run a subset of rules
- `kit self-audit --fail-on-warning`: Treat warnings as failures (errors fail by default; warnings do not)

Error-severity findings (missing CI script, reintroduced `|| true`, unguarded import) exit non-zero. It runs in kit's own CI (the `self-audit` job feeds the security gate), warn-only for the first rollout so only error-severity findings block.

### Built-in git hooks

`kit hooks add <name>` installs a managed hook that calls back into kit. No `.kit.toml` config required.

- `secret-scan` (pre-commit): Block commits that introduce known credential patterns
- `post-pull-audit` (post-merge): Run `verify-pull` after every `git pull` / merge
- `context-check` (pre-push): Block a push when the live CLI context does not match `.kit.toml [context]` (see Context lock)

### Environments + elevation

Production credentials are gated behind explicit env-switching and short-lived elevation.

- `kit env switch <dev|staging|prod>`: Toggle the active environment marker
- `kit env current`: Show active env (color-coded), `kit env list` for available
- `kit auth elevate [--scope <op>] [--ttl-minutes N]`: Mint a TTL'd elevation marker (TOTP or yes-prompt). Required before any destructive secret op. `--list-scopes` (also `--json`) prints every scope, what it unlocks, and whether it is one-shot — without elevating anything.
- `kit auth setup-totp`: One-time TOTP enrollment (writes `~/.kit/totp-secret` 0600)
- `kit auth status`: Show active elevation
- `kit auth revoke`: Drop the elevation marker early
- `kit audit secrets [--since-days N] [--key <name>]`: Forensics: who touched which key, when
- `kit audit verify [--strict]`: Verify the keyless hash chain + the external HMAC anchor (a tip mismatch is a keyless prefix rewrite, a count mismatch is truncation/rollback). `--strict` (or `[governance.audit].require_anchor`, or once the machine has anchored any log) turns an unanchored log / unreadable key / unsealed tail into a hard failure, so a project-writable `log_file` cannot repoint verification at a forged, never-anchored file and pass
- `kit audit anchor`: Seal the current log with the machine-local anchor key (`~/.kit/audit-anchor.key`, `0600`) so a later keyless rewrite or truncation is detectable. The append path stays keyless (a sandboxed agent with no key keeps logging); the key is only needed to seal/verify. Key rotation reports as a distinct `anchor-key-changed` status, not a false tamper alarm. Honest scope: this is not tamper-proof against a same-UID principal who can read the key
- `kit check --attest` / `kit ci --attest` / `KIT_ATTEST=1`: opt-in, fail-soft (never blocks or alters the verdict). Writes `.kit-check-attestation.json` recording which scanners actually ran plus the verdict, signed with the machine-local anchor key (authoritative; the verifier needs that key). An Ed25519 receipt is a portable fallback whose embedded public key is **untrusted**: `kit check verify-attestation <file>` reports `unverified-authenticity` (not green) unless the key is pinned (TOFU in `~/.kit`, refuses silent overwrite) or passed via `--key`

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
- `kit review`: Meta-runner: `check` + `design` + `standards` + `adr` in one command. Use as a single PR-gate entry point for AI agents
- `kit adr {check,list,freeze}`: Enforce accepted ADRs' machine-readable `kit-enforce` rules over the repo, cited back to the ADR ("why is this blocked? → ADR-0007"). Rule types: `forbid_pattern`, `require_pattern`, and import-aware `forbid_import` (direct + transitive; `follow_packages = true` also walks across npm package boundaries, catching "web must never reach `pg`, even through a wrapper dependency"). Anything the walk cannot follow to the end — an unresolvable import, an unreadable module, a depth/node bound — is surfaced as a `gap`, never a silent pass. Only `accepted` ADRs gate; prose is never interpreted (zero-LLM). `freeze` baselines existing findings so only NEW ones fail
- `kit baseline freeze`: Snapshot current findings (untested files, a11y, tokens, standards, ADR violations/gaps) into `.kit-baseline.json` so pre-existing warnings stay warnings and only net-new findings can fail
- `kit baseline show`: Print current baseline

### Supply chain

- **Bumblebee**: Built-in supply-chain scanner. Verifies every dependency against pinned SHA-256 checksums in `bumblebee.lock.json`. Re-verifies the cache before reuse so a tampered local file is caught (kind `integrity`). Runs in CI on every PR
- `kit triage npm|pip|docker|repo|skill <target>`: Pre-install security evaluation via triage skill
- `kit triage npm <pkg> --sandbox`: Offline behavioral inspection: `npm pack` → extract → scan for install scripts, eval/base64/network patterns, unexpected scripts, oversized files. No code executes
- `kit scan`: Run the installed external scanners (Snyk, Trivy, Grype, Semgrep, osv-scanner, Socket) and merge them into one local, air-gap-aware verdict. **GuardDog** (opt-in via `KIT_GUARDDOG=1` or `[scan] guarddog`) adds local malware detection. The **cloud** scanners (Snyk, Socket) run when their token is set (`SNYK_TOKEN` / `SOCKET_SECURITY_API_TOKEN`, resolved from `[scan.tooling]` vault or env — kit never stores them) and are **dropped in air-gap** mode; `kit setup` asks the network posture (connected vs enclave) and writes `[air_gap]`. Socket has no stable findings-JSON, so kit gates on `socket ci`'s exit code (never false-green). Token absent → the scanner is skipped, not failed
- **Scanner-health gate.** The exit verdict accounts for scanner _health_, not just findings: a scanner that errored, isn't installed, or lacked its token can no longer exit 0 (a false green). Default is a loud warn (no existing green CI breaks); opt in to a hard fail via `[governance.scan].required_scanners` (a listed scanner that didn't run fails) or `kit ci --strict` / `KIT_CI_STRICT=1` (any non-running scanner fails)
- `kit airgap verify`: assert every scanner that would run in air-gap mode resolves to a local artifact (no cloud-only scanner, no registry config) and print a pass/fail table. In air-gap mode a registry (`p/…`) `KIT_SEMGREP_CONFIG` is refused in both scan paths (it would egress to the semgrep registry), while a **local** ruleset path is kept so semgrep can still run fully offline
- Supply-chain findings auto-append to `.kit-audit.jsonl` (one JSON line per finding) for SIEM ingest
- Releases ship with SLSA provenance (`npm publish --provenance`), CycloneDX + SPDX SBOMs on every GitHub release, cosign-signed Docker images, and weekly OpenSSF Scorecard

### Compliance evidence

`kit coverage` emits deterministic _evidence maps_: it maps kit's own checks and self-audit rules to a vendored, pinned, curated subset of a standard's controls and buckets each as auto-verified, gap, manual, or n-a. `--json` (or `--format=json`) emits the structured report for a GRC tool to consume.

Eight standards are registered (`--list-standards`; `--standard=<key>`, or `all`): OWASP **ASVS 4.0.3 L2** (default) · **LLM Top 10** · **Agentic Top 10** · **MCP Top 10** · NIST **SSDF 800-218A** · **NIST 800-53 Rev. 5** · **AIUC-1** · **GCP WAF Security**. Toggle the set with `[coverage].standards` in `.kit.toml` (absent ⇒ all on).

The NIST 800-53 map is deliberately at the **control-family** level (20 families, not ~1000 controls): a family bucketed `auto` means kit emits deterministic evidence relevant to it — never that every control in it is satisfied. Physical, personnel, and organizational families (PE/PS/AT/CP/MA/MP) are `n-a` by charter rather than quietly claimed.

It is explicitly **an evidence map, not a compliance attestation**: it never claims "compliant". The goal is to be the deterministic evidence source a GRC tool ingests, not a worse version of one. (`experimental` tier.)

### Stability & contracts

As of 2.0, kit's public surfaces are versioned contracts, not just code that happens to work today.

- **Command stability tiers.** Every command carries a `stable | experimental | deprecated` tier. `stable` commands will not be removed, renamed, or have their exit-code / `--json` semantics broken across 2.x (additive-only in minor releases). All shipped commands are `stable` except `team` (`experimental`); `deprecated` commands print a stderr warning every run. A committed `contracts/public-surface.json` golden snapshot plus a drift test enforce this: a surface change fails CI until it is reviewed, regenerated, and labeled `BREAKING`. See [docs/CLI_STABILITY.md](docs/CLI_STABILITY.md).
- **Versioned `.kit.toml`.** The config carries a top-level `version` (`CONFIG_SCHEMA_VERSION = 1`; an absent field is treated as legacy v0). `kit config migrate` runs an ordered, fixture-tested migration from the detected version to the current one: `--dry-run` (the default, which prints the plan and a value-level diff and writes nothing), a real run writes `.kit.toml.backup` first (refuses to clobber an existing backup without `--force`) then re-parses and validates the result and restores the original on any failure, and `--check` exits non-zero on a stale config for CI. **Upgrade note:** run `kit config migrate` once; v1 is the baseline (a no-op version stamp), so nothing breaks today, but the migration path is now in place for any future schema change.
- **`adapter-sdk@1.0`** is frozen on its own semver track, decoupled from kit's version, with a documented public surface, a kit-compatibility matrix, and caret-pin guidance (see [docs/API_STABILITY_AND_VERSIONING.md](docs/API_STABILITY_AND_VERSIONING.md)).

## Memory

`kit memory` gives an agent a local-first, deterministic second brain, it stores
your raw conversation history and searches it _before answering_, so it pulls
receipts instead of guessing. SQLite + FTS5, three hooks, no vectors, no model calls.
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

| Service               | Purpose                                               |
| --------------------- | ----------------------------------------------------- |
| `stripe/payments`     | Stripe payment processing (products + price IDs)      |
| `supabase/db`         | Supabase database + authentication                    |
| `vercel/hosting`      | Vercel hosting + deployment                           |
| `flyio/hosting`       | Fly.io container deployment                           |
| `railway/hosting`     | Railway (Heroku-style) deployment                     |
| `neon/db`             | Neon serverless Postgres                              |
| `planetscale/db`      | PlanetScale serverless MySQL                          |
| `upstash/redis`       | Upstash serverless Redis                              |
| `cloudflare/r2`       | Cloudflare R2 object storage (S3-compatible)          |
| `clerk/auth`          | Clerk authentication + user management                |
| `resend/email`        | Resend transactional email                            |
| `loops/email`         | Loops marketing + transactional email                 |
| `sentry/monitoring`   | Sentry error tracking + performance monitoring        |
| `posthog/analytics`   | PostHog product analytics + session recording         |
| `tinybird/analytics`  | Tinybird real-time analytics on ClickHouse            |
| `liveblocks/realtime` | Liveblocks collaborative realtime (presence, cursors) |
| `trigger/background`  | Trigger.dev background jobs                           |
| `inngest/background`  | Inngest event-driven background jobs                  |
| `flagsmith/flags`     | Flagsmith feature flags + remote config               |
| `expo/eas`            | Expo Application Services (mobile builds)             |
| `searxng/instance`    | Self-hosted SearXNG search engine                     |

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
| `kit_review`    | Full repo audit — check + design + standards + ADR gates as one structured report              |
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
