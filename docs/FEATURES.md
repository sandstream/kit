# kit features

The full feature reference, moved out of the README so the README stays under npm's
package-page limit. The README keeps the overview; this page keeps the detail.

## Agent support and features

kit is **agent-agnostic** — it's a CLI that any coding agent can run, plus opt-in
adapters for the surfaces each agent exposes. Support today, per agent:

| Agent             | Memory index¹ |    "use kit" rules block²    |         Agent/MCP config audit³         | Perm allowlist⁴ | Auto-capture hooks⁵ | Blocking gate⁶ |
| :---------------- | :-----------: | :--------------------------: | :-------------------------------------: | :-------------: | :-----------------: | :------------: |
| **Claude Code**   |      ✅       |        ✅ `CLAUDE.md`        |   ✅ + commands/agents/skills/plugins   |       ✅        |         ✅          |    ✅ hook     |
| **OpenAI Codex**  |      ✅       |        ✅ `AGENTS.md`        |           ✅ `.codex/config`            |        —        |         ✅          |    ✅ hook     |
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
4. kit can pre-authorize its read-only commands so they run without a prompt (Claude Code's `permissions.allow` today). Codex has no equivalent command allowlist, so `kit agent-config` writes a personal `codex --profile kit` preset (`approval_policy = "on-request"`, `sandbox_mode = "workspace-write"`) under `$CODEX_HOME` / `~/.codex` instead of committing a repo risk preference.
5. `kit memory install` registers lifecycle hooks so capture happens automatically in Claude Code (`~/.claude/settings.json`) and Codex (`~/.codex/hooks.json`). Codex requires review/trust through `/hooks` before new command hooks run.
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
  ! 1 issue(s) require human action:

HITL required
Blocker: stripe is not authenticated
Owner: provider admin
Why the agent cannot resolve this: auth / browser / external account
Do this:
1. Run `kit login --service stripe` in a normal terminal/browser session, or run `stripe login`.
2. Run `kit check --category services,secrets`.
Respond with: stripe configured/authenticated; no secret values pasted
Agent continues with: kit check --category services,secrets
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

Trust model documented in [`docs/THREAT_MODEL.md`](THREAT_MODEL.md);
data flow per command in [`docs/DATA_FLOW.md`](DATA_FLOW.md);
release-verification in [`docs/VERIFY.md`](VERIFY.md); how a release is cut, and
the migration off a long-lived npm token, in
[`docs/RELEASING.md`](RELEASING.md). kit's verdicts are
produced by deterministic code, never an LLM — a CI-enforced contract, see
[`docs/ZERO_LLM_CONTRACT.md`](ZERO_LLM_CONTRACT.md).

- `kit doctor`: Deep diagnostics: Node.js version, mise, .env.local, tools in PATH, git hooks, **which hosts the triage gate points at** (public defaults vs internal mirrors / GitHub Enterprise — offline, so it never claims the hosts are *reachable*; it warns when `[air_gap]` is enabled while probes still point at public registries), and **OS containment posture** — detects the sandbox *below* the tool boundary (container / seccomp / user-ns, and gVisor / Firecracker fingerprints) and reports it honestly (`unknown` on non-Linux, never a false "not contained"). Set `[governance.containment] require = true` to make it a **fail-closed gate**: doctor fails when containment can't be positively established (including when it can't be determined). kit detects/verifies a sandbox — it never becomes one
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

### Deploy env matrix

Declare deploy-time key names in `.kit.toml`; commit names, never values. `kit check --category deploy` lists remote key names from the platform and diffs them against the declaration. With `VERCEL_TOKEN`, `project` is the active Vercel project name/id selector; without a token, kit falls back to the Vercel CLI and the target `cwd` link. `NEXT_PUBLIC_*` keys are treated as build-time: after setting one, redeploy before expecting the running frontend to see it.

```toml
[deploy.vercel]
scope = "example-team" # CLI fallback scope
team_id = "team_123"   # API selector when VERCEL_TOKEN is present
environment_specific = ["NEXT_PUBLIC_SITE_URL"]

[deploy.vercel.environments.production]
project = "app-prod"
remote_env = "production"
required = ["NEXT_PUBLIC_SENTRY_DSN", "NEXT_PUBLIC_SENTRY_ENVIRONMENT"]

[deploy.vercel.environments.staging]
project = "app-stg"
remote_env = "production" # separate staging project; use "preview" for preview builds
required = ["NEXT_PUBLIC_SENTRY_DSN", "NEXT_PUBLIC_SENTRY_ENVIRONMENT"]
```

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
- `kit monkey-test`: Role-based release gate for money-handling apps: stack/env/seed detection, Playwright desktop+mobile crawl, sandbox money flow, and security pack. See [docs/MONKEY_TEST.md](MONKEY_TEST.md)
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
- Supply-chain findings auto-append to `.kit-findings.jsonl` (one JSON line per finding). They stay separate from the hash-chained `.kit-audit.jsonl`, whose integrity would be broken by raw finding rows
- Releases ship with SLSA provenance (`npm publish --provenance`), CycloneDX + SPDX SBOMs on every GitHub release, cosign-signed Docker images, and weekly OpenSSF Scorecard

### Shell guard (observe mode)

The agent loop is gated (the PreToolUse install-gate across 11 harnesses), but a
human typing `npm i x` / `npx y` / `brew install z` in their own terminal reaches
the machine ungated. `kit guard install` writes PATH shims for the install +
fetch-and-run family (`npm npx pnpm yarn bun bunx pip pip3 pipx uv uvx brew gem
cargo git`) that run the **same hardened parser + triage verdict** the agent gate
uses — and log what it WOULD decide to `~/.kit/guard-observe.jsonl`.

v1 is **observe-only** by the exec-broker discipline (observe → evidence →
enforce): a shim never blocks and never breaks the tool — kit missing or
crashing means unchanged behavior, non-install subcommands pass silently, and
`KIT_GUARD_BYPASS=1` skips observation for one call. `kit guard status` shows
what has passed through, what enforce mode would have stopped, and whether a
fresh login shell actually resolves each guarded tool to kit's shim (so a later
PATH prepend cannot silently displace it); `kit guard uninstall` removes
everything. `git clone` is **observe-only**, not hard-gated: the shim records
repo intake and points at `kit triage repo <url>` for third-party dependencies.
Notable: the shims also see the `npx`-spawned
MCP servers agent harnesses launch **outside** any Bash gate — coverage the
PreToolUse hook can't reach.

A shim hands the call to the next match on `PATH`, so another shim manager
(mise, asdf, pyenv, rbenv) still chooses which version runs — but kit drops its
own directory from `PATH` before handing off into one, because those managers
re-resolve the tool through `PATH` and would otherwise land back in kit's shim
forever ([#461](https://github.com/sandstream/kit/issues/461)). Shims also
self-heal: `kit guard-observe` rewrites the shim that called it when the file
predates the running kit version, so an upgrade doesn't leave old wrappers
behind, and `kit guard status` names any that are still stale.

### Compliance evidence

`kit coverage` emits deterministic _evidence maps_: it maps kit's own checks and self-audit rules to a vendored, pinned, curated subset of a standard's controls and buckets each as auto-verified, gap, manual, or n-a. `--json` (or `--format=json`) emits the structured report for a GRC tool to consume.

Eight standards are registered (`--list-standards`; `--standard=<key>`, or `all`): OWASP **ASVS 4.0.3 L2** (default) · **LLM Top 10** · **Agentic Top 10** · **MCP Top 10** · NIST **SSDF 800-218A** · **NIST 800-53 Rev. 5** · **AIUC-1** · **GCP WAF Security**. Toggle the set with `[coverage].standards` in `.kit.toml` (absent ⇒ all on).

The NIST 800-53 map is deliberately at the **control-family** level (20 families, not ~1000 controls): a family bucketed `auto` means kit emits deterministic evidence relevant to it — never that every control in it is satisfied. Physical, personnel, and organizational families (PE/PS/AT/CP/MA/MP) are `n-a` by charter rather than quietly claimed.

It is explicitly **an evidence map, not a compliance attestation**: it never claims "compliant". The goal is to be the deterministic evidence source a GRC tool ingests, not a worse version of one. (`experimental` tier.)

### Stability & contracts

As of 2.0, kit's public surfaces are versioned contracts, not just code that happens to work today.

- **Command stability tiers.** Every command carries a `stable | experimental | deprecated` tier. `stable` commands will not be removed, renamed, or have their exit-code / `--json` semantics broken across 2.x (additive-only in minor releases). All shipped commands are `stable` except `team` (`experimental`); `deprecated` commands print a stderr warning every run. A committed `contracts/public-surface.json` golden snapshot plus a drift test enforce this: a surface change fails CI until it is reviewed, regenerated, and labeled `BREAKING`. See [docs/CLI_STABILITY.md](CLI_STABILITY.md).
- **Versioned `.kit.toml`.** The config carries a top-level `version` (`CONFIG_SCHEMA_VERSION = 1`; an absent field is treated as legacy v0). `kit config migrate` runs an ordered, fixture-tested migration from the detected version to the current one: `--dry-run` (the default, which prints the plan and a value-level diff and writes nothing), a real run writes `.kit.toml.backup` first (refuses to clobber an existing backup without `--force`) then re-parses and validates the result and restores the original on any failure, and `--check` exits non-zero on a stale config for CI. **Upgrade note:** run `kit config migrate` once; v1 is the baseline (a no-op version stamp), so nothing breaks today, but the migration path is now in place for any future schema change.
- **`adapter-sdk@1.0`** is frozen on its own semver track, decoupled from kit's version, with a documented public surface, a kit-compatibility matrix, and caret-pin guidance (see [docs/API_STABILITY_AND_VERSIONING.md](API_STABILITY_AND_VERSIONING.md)).

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

Add your own with `kit create-plugin <name>` (see [docs/PLUGIN_DEVELOPMENT.md](PLUGIN_DEVELOPMENT.md)).

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

See [docs/CUSTOM_ADAPTERS.md](CUSTOM_ADAPTERS.md) for a complete guide on creating custom service adapters.

**Troubleshooting:**

Common issues and solutions:

- **"Required tool not installed"**: Install the service's CLI tool (see examples above)
- **"Not authenticated"**: Run the service's login command (e.g., `stripe login`)
- **"Provisioning failed"**: Check CLI is in your PATH: `which stripe`
- For more help, see [docs/CUSTOM_ADAPTERS.md](CUSTOM_ADAPTERS.md#troubleshooting)
