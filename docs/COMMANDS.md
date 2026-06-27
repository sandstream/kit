# kit commands

> Complete reference for every `kit <subcommand>`. Last updated 2026-06-27 (kit 2.0.0).
> Pair this with `docs/THREAT_MODEL.md` (what data flows where) and
> `docs/DATA_FLOW.md` (exact reads/writes per op).

## Global flags

| Flag                         | Effect                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------ |
| `--read-only` / `--readonly` | Activate session-wide refusal of every mutating op. Also honored as `KIT_READ_ONLY=1` env. |
| `--non-interactive`          | Skip all confirmation prompts. Required in CI / agent contexts.                            |
| `--version` / `-v`           | Print kit version + exit.                                                                  |
| `--help` / `-h`              | Print top-level help + exit.                                                               |

## Core lifecycle

| Command                                                   | Purpose                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kit init`                                                | Auto-detect project stack → generate `.kit.toml` + lockfiles.                                                                                                                                                                                                                                                                                                        |
| `kit setup [--mode <name>]`                               | 6-step orchestrator: install → hooks → login → secrets → agent-config → verify, preceded by a network-posture prompt. `--mode` (or `[setup].mode`) selects a preset: `full` (default) · `local` · `airgap` (forces air-gapped posture) · `ci` · `agent` · `review` (read-only) · `minimal`. `--recommended` also wires memory + git secret-scan/context-check gates. |
| `kit statusline [--mode <name>]`                          | Compact one-line status (mode score · update available · open PAL count) for any agent's info bar — wire into Claude Code `statusLine` or a shell PS1. Fast, read-only, cached.                                                                                                                                                                                      |
| `kit check`                                               | Verify tools / services / secrets / skills / hooks / security / tests.                                                                                                                                                                                                                                                                                               |
| `kit check --attest`                                      | Opt-in, fail-soft: write a signed `.kit-check-attestation.json` receipt recording which scanners actually ran + the verdict (HMAC-signed with the machine-local anchor key; never blocks or alters the verdict). Also `kit ci --attest` / `KIT_ATTEST=1`.                                                                                                            |
| `kit check verify-attestation <file> [--key <k>] [--pin]` | Verify a check receipt. HMAC against the local anchor key is authoritative; an Ed25519 receipt's embedded key is untrusted and reports `unverified-authenticity` unless the key is pinned (TOFU in `~/.kit`) or passed via `--key`.                                                                                                                                  |
| `kit config migrate [--dry-run] [--check] [--force]`      | Migrate `.kit.toml` to the current schema `version` (`CONFIG_SCHEMA_VERSION`). `--dry-run` (default) prints the plan + value diff and writes nothing; a real run backs up to `.kit.toml.backup`, re-validates, and restores on any failure; `--check` exits non-zero on a stale config (CI). v0→v1 only stamps the version (baseline no-op).                         |
| `kit coverage [--json]`                                   | OWASP ASVS 4.0.3 L2 **evidence map** that buckets kit's checks/rules per control as auto-verified / gap / manual / n-a. Evidence, **not** a compliance attestation (never claims "compliant"); `--json` for GRC tools. `experimental`.                                                                                                                               |
| `kit health [--json]`                                     | Deep environment health diagnostics — granular pass/fail across tools, services, and config (more detail than `check`).                                                                                                                                                                                                                                              |
| `kit status [--json]`                                     | Adoption checklist — which subsystems are set up (config, vault, tools, gitignore hygiene, dependency policy, agent-config, memory, hooks) + the next step for each gap.                                                                                                                                                                                             |
| `kit install`                                             | Install missing tools declared in `[tools]` via mise.                                                                                                                                                                                                                                                                                                                |
| `kit login [--service <name>] [--retry-count <N>]`        | Guided login to configured services. Optionally narrow to one service / retry failures with backoff.                                                                                                                                                                                                                                                                 |
| `kit login --plan [--json]`                               | Read-only: show the resolved auth strategy per service (vault / interactive / capture) + a passkey warning for browser logins that can't be scripted on a fresh machine.                                                                                                                                                                                             |
| `kit skills`                                              | Check status of agent skills declared in `[skills]` against the registry (clawhub default).                                                                                                                                                                                                                                                                          |
| `kit fix`                                                 | Auto-remediate common gaps (tools, lockfiles, gitignore, hooks, .env.template).                                                                                                                                                                                                                                                                                      |
| `kit heal [--dry-run] [--agent]`                          | Bounded self-heal loop: auto-fix safe findings, re-scan until green; gates destructive ops, fail-closed on tamper.                                                                                                                                                                                                                                                   |
| `kit upgrade`                                             | Refresh lockfiles from `.kit.toml`.                                                                                                                                                                                                                                                                                                                                  |
| `kit doctor`                                              | Diagnostic sweep — surfaces config drift + CLI version skew.                                                                                                                                                                                                                                                                                                         |
| `kit clone <url>`                                         | Clone + setup in one step (skip setup with `--no-setup`).                                                                                                                                                                                                                                                                                                            |

## Code quality + reviews

| Command                 | Purpose                                                                |
| ----------------------- | ---------------------------------------------------------------------- |
| `kit design`            | A11y + design-token checks, baseline-aware.                            |
| `kit review`            | Meta-runner — `check + design + tests` gate for PR.                    |
| `kit baseline [freeze]` | Snapshot current acceptable warnings to `.kit-baseline.json`.          |
| `kit analyze [--write]` | Mine git history + framework markers → draft `CLAUDE.md` / `RULES.md`. |

## Secrets

| Command                                                              | Purpose                                                                                                             |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `kit secrets sync [--target=<github\|dotenv-ci\|stdout>]`            | Sync vault → CI / `.env.local`.                                                                                     |
| `kit secrets migrate [--keep-commented \| --purge]`                  | Plaintext `.env*` → vault. Default leaves `KEY=` (value blanked).                                                   |
| `kit secrets vault-migrate --from <a> --to <b>`                      | Cross-vault key transfer (1Password → Infisical, etc.).                                                             |
| `kit secrets set <KEY> [--stdin \| --value <v>] [--store <backend>]` | Capture a value to the vault. `--stdin` (safer — not in argv/ps) or `--value`. Execution behind `auth = "capture"`. |
| `kit secrets rotate [--mode <jwt-secret-roll \| scoped-key-mint>]`   | Rotate via supabase-mgmt-api. JWT roll is one-shot elevation.                                                       |
| `kit secrets onecli register`                                        | Register fake-key in OneCLI gateway.                                                                                |
| `kit secrets purge-history --force-history`                          | git-history rewrite to scrub leaked credentials.                                                                    |
| `kit secrets propagate`                                              | Sync vault → deploy platform (Vercel / Fly / etc.).                                                                 |
| `kit secrets revoke-old`                                             | Revoke superseded credential after rotation.                                                                        |
| `kit secrets pull --from <vercel\|github\|fly\|cloudflare>`          | Read env-vars from deploy platform into vault.                                                                      |
| `kit secrets set-value <KEY> <VALUE>`                                | Write a single key/value to the configured vault.                                                                   |
| `kit secrets validate [--fix\|--auto]`                               | Verify every declared key resolves in vault. `--auto` pulls from `.env.template`.                                   |

## Auth + elevation

| Command                                                 | Purpose                                                         |
| ------------------------------------------------------- | --------------------------------------------------------------- |
| `kit auth elevate [--scope <name>] [--ttl-minutes <N>]` | TTY prompt + TOTP → mints elevation marker for destructive ops. |
| `kit auth status`                                       | Show current elevation state.                                   |
| `kit auth revoke`                                       | Clear elevation marker.                                         |
| `kit auth setup-totp`                                   | Enroll TOTP secret in `~/.kit/totp-secret`.                     |

## Environment

| Command                          | Purpose                                                                                       |
| -------------------------------- | --------------------------------------------------------------------------------------------- |
| `kit env list`                   | List configured environments (`[env.<name>]`).                                                |
| `kit env switch <env>`           | Activate env in `.kit/active-env.json`.                                                       |
| `kit env current`                | Print active env.                                                                             |
| `kit env diff --compare <other>` | Drift report between two `.env*` files (values shown as sha256:8 prefixes — never plaintext). |

## MCP orchestrator

| Command                                                | Purpose                              |
| ------------------------------------------------------ | ------------------------------------ |
| `kit mcp` / `kit mcp list`                             | Show declared MCPs + auth status.    |
| `kit mcp status`                                       | Alias for `list`.                    |
| `kit mcp auth <name>`                                  | Show OAuth-flow guidance for vendor. |
| `kit mcp set-token <name> [--from-env VAR \| --paste]` | Headless / paste-token install.      |
| `kit mcp clear <name>`                                 | Remove stored token.                 |

## Hooks

| Command                | Purpose                                                                                               |
| ---------------------- | ----------------------------------------------------------------------------------------------------- |
| `kit hooks install`    | Install pre-commit / post-commit hooks declared in `[hooks]`. Pulls in bypass-detector sentinel pair. |
| `kit hooks add <name>` | Add a built-in hook (secret-scan, post-pull-audit).                                                   |
| `kit hooks sync`       | Reconcile installed hooks with config.                                                                |

## Security

| Command                                                                    | Purpose                                                                                                         |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `kit security check-gitignore [--fix]`                                     | Verify secret-file patterns are gitignored.                                                                     |
| `kit security scan-staged`                                                 | Block commit if staged files contain credential patterns.                                                       |
| `kit security verify-pull [--base <ref>]`                                  | Post-`git pull` audit: new deps, gitignore drops, introduced secrets.                                           |
| `kit security scan-build [<dir>]`                                          | Walk `.next` / `dist` for credential leaks in build artifacts.                                                  |
| `kit security clear-cache`                                                 | Wipe bumblebee cache.                                                                                           |
| `kit security costs`                                                       | Run cost-monitor leak-detection (P3.1).                                                                         |
| `kit security policy`                                                      | Validate `.kit-allowlist.json` against current deps.                                                            |
| `kit security scan-transcripts`                                            | Scan agent transcripts + prompt caches for leaked credentials.                                                  |
| `kit security prescan <path> [--deep] [--format=json] [--vs-baseline=<p>]` | Multi-repo baseline sweep (secrets, gitignore, branch-protect; `--deep` adds CVE / workflow-drift / bumblebee). |
| `kit security prescan-diff <baseline.jsonl> <latest.jsonl>`                | Diff two prescan reports — surface new regressions + fixed findings.                                            |

## Supply chain + scanners

| Command                                                                                            | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kit scan [--sarif]`                                                                               | Run installed external scanners (Snyk, Trivy, Grype, Semgrep, osv-scanner, **Socket**) and merge into one local, air-gap-aware verdict. **GuardDog** opt-in via `KIT_GUARDDOG=1` / `[scan] guarddog`. Cloud scanners (Snyk, Socket) run when their token is set (`SNYK_TOKEN` / `SOCKET_SECURITY_API_TOKEN`, from `[scan.tooling]` vault or env) and are **dropped in air-gap**; Socket gates on `socket ci`'s exit code (no stable findings-JSON, never false-green). Token absent → skipped, not failed.                                                           |
| `kit airgap verify [--json]`                                                                       | Prove air-gap posture: assert every scanner that would run in air-gap mode resolves to a local artifact (no cloud-only scanner, no registry config); print a pass/fail table. A registry (`p/…`) `KIT_SEMGREP_CONFIG` is refused in air-gap (egress), while a local ruleset path is kept so semgrep runs offline.                                                                                                                                                                                                                                                    |
| `kit supply-chain`                                                                                 | Install-time supply-chain triage: install-scripts, lockfile-drift, dep-confusion, slopsquat.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `kit agent-audit`                                                                                  | Audit agent / MCP / hook configs for plaintext secrets + malware-shaped hooks.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `kit gha-audit`                                                                                    | GitHub Actions hardening lint — unpinned action refs + pwn-request patterns in `.github/workflows`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `kit self-audit [--only <ids>] [--list-rules] [--format=github\|gitlab\|json] [--fail-on-warning]` | Zero-LLM, deterministic self-check of kit's own source (walks `src/*.ts`, no network). Scans for the audit's bug-classes (reintroduced `\|\| true`, unguarded dynamic imports, etc.) and asserts every script referenced from `.github/workflows/*.{yml,yaml}` (node/python files, `npm run` targets) exists. `--list-rules` prints the rule set without running. Error-severity findings (missing CI script, reintroduced `\|\| true`, unguarded import) exit non-zero; warnings do not unless `--fail-on-warning`. Runs in kit's own CI feeding the security gate. |
| `kit sbom [--format cyclonedx\|spdx]`                                                              | Generate an SBOM from the lockfile.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `kit ingest <sarif\|osv> <file>`                                                                   | Ingest an external SARIF / OSV report into kit's consolidated verdict (one parser per format).                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `kit verify-provenance <bundle>`                                                                   | Verify a release's SLSA provenance bundle offline (Ed25519 + SHA-256 / cosign `--offline`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `kit sentinel <run\|install\|status> [--json]`                                                     | Autonomous redline watcher — propose/apply guarded remediations; `install` scaffolds the GitHub Actions workflow.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

## Triage (pre-install)

| Command                          | Purpose                                                              |
| -------------------------------- | -------------------------------------------------------------------- |
| `kit triage npm <pkg>`           | Evaluate npm package: registry + GitHub health.                      |
| `kit triage npm <pkg> --sandbox` | + offline tarball inspection (install-script + path-traversal scan). |
| `kit triage pip <pkg>`           | PyPI evaluation.                                                     |
| `kit triage docker <image>`      | Docker image: CVE + sandbox.                                         |
| `kit triage repo <github-url>`   | GitHub repo evaluation.                                              |
| `kit triage skill <path\|name>`  | Claude Code / agent skill evaluation.                                |
| `kit triage all <target>`        | Auto-detect + run all checks.                                        |
| `kit triage tools`               | List installed security tools.                                       |
| `kit triage check-deps`          | Pre-commit gate: fail if staged deps lack triage entries.            |

## Packages + plugins

| Command                      | Purpose                               |
| ---------------------------- | ------------------------------------- |
| `kit pkg install <pkg>`      | Triage → install with pinned version. |
| `kit plugin search <query>`  | Search plugin marketplace.            |
| `kit plugin install <id>`    | Install a plugin.                     |
| `kit plugin info <id>`       | Plugin metadata.                      |
| `kit plugin scaffold <name>` | Generate a new plugin skeleton.       |

## Governance

| Command                                               | Purpose                                                                                                                                                                                                                                                               |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kit governance status`                               | Budget + revocation + agent info.                                                                                                                                                                                                                                     |
| `kit audit`                                           | Print recent `.kit-audit.jsonl` entries.                                                                                                                                                                                                                              |
| `kit audit secrets [--key <name>] [--since-days <N>]` | Forensics: who/what touched each key + when.                                                                                                                                                                                                                          |
| `kit audit verify [--strict]`                         | Verify the keyless hash chain + the external HMAC anchor (tip mismatch = keyless rewrite, count mismatch = truncation; exit 1 on break/forge). `--strict` / `[governance.audit].require_anchor` makes an unanchored log / unreadable key / unsealed tail a hard fail. |
| `kit audit anchor`                                    | Seal the log with the machine-local anchor key (`~/.kit/audit-anchor.key`, `0600`) so a keyless rewrite/truncation is detectable. Append path stays keyless; not tamper-proof against a same-UID key reader.                                                          |
| `kit audit export [--format cef\|syslog\|json]`       | Emit the audit log for a SIEM.                                                                                                                                                                                                                                        |
| `kit whoami [--json]`                                 | Show current agent / user identity, active environment, and budget usage.                                                                                                                                                                                             |
| `kit team create <name>`                              | Create a new team.                                                                                                                                                                                                                                                    |
| `kit team invite <email> [--role=<role>]`             | Invite a user to the team (roles: owner, admin, developer, guest).                                                                                                                                                                                                    |
| `kit team members list`                               | List team members.                                                                                                                                                                                                                                                    |
| `kit team member remove <email>`                      | Remove a team member.                                                                                                                                                                                                                                                 |
| `kit team audit log [--limit=<N>]`                    | View team audit logs.                                                                                                                                                                                                                                                 |

## Misc

| Command                             | Purpose                                                                                                                                                                                                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `kit open <service>`                | Open service dashboard in browser (stripe, vercel, etc.).                                                                                                                                                                                                    |
| `kit run <cmd>`                     | Arbitrary command runner (audit-logged).                                                                                                                                                                                                                     |
| `kit escalate`                      | Collect failures + format for manual handoff.                                                                                                                                                                                                                |
| `kit ci [--strict] [--attest]`      | One-shot CI gate (check + design + tests). Scanner-health gate: a crashed / missing / token-less scanner can no longer exit 0 (default warns); `--strict` / `KIT_CI_STRICT=1` (or `[governance.scan].required_scanners`) hard-fails any non-running scanner. |
| `kit context [--format json]`       | Print kit context for agent introspection.                                                                                                                                                                                                                   |
| `kit create-plugin <name>`          | Scaffold a new adapter.                                                                                                                                                                                                                                      |
| `kit add <service>`                 | Add service to `.kit.toml`.                                                                                                                                                                                                                                  |
| `kit version`                       | Print kit version + exit.                                                                                                                                                                                                                                    |
| `kit completions <bash\|zsh\|fish>` | Output shell completion script for the given shell.                                                                                                                                                                                                          |

## Memory

Local-first second brain — SQLite + FTS5, deterministic, zero model calls. Full guide: `docs/MEMORY.md`.

| Command                                                                     | Purpose                                                                                                                  |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `kit memory index`                                                          | Index `~/.claude` transcripts into `~/.kit/memory.db` (idempotent).                                                      |
| `kit memory search <query>`                                                 | Full-text recall; defaults to the current project, `--global` across all.                                                |
| `kit memory stats`                                                          | Sessions / messages / tool-uses / DB size.                                                                               |
| `kit memory suggest [--limit N] [--json]`                                   | Emit a BYO-LLM review prompt (recent activity + open items) to stdout — pipe to your own model. kit never calls a model. |
| `kit memory install` / `uninstall`                                          | Wire (or remove) the `UserPromptSubmit` + `SessionEnd` hooks in `~/.claude/settings.json`.                               |
| `kit memory scan`                                                           | Scan the store for stored secrets (masked; exits 1 if any found).                                                        |
| `kit memory backup <file>` / `restore <file>`                               | Encrypted AES-256-GCM backup/restore (`KIT_MEMORY_PASSPHRASE`).                                                          |
| `kit memory pal [list\|add\|done\|snooze\|verify\|import]`                  | Pending-action ledger; auto-closes on verify. Project-scoped (`--global` for all).                                       |
| `kit memory save <name>` / `threads` / `resume <name\|n>` / `forget <name>` | Named copilots — bookmark + resume sessions.                                                                             |
| `kit memory share …` / `areas` / `area <name>`                              | Shared, area-organized team memory (committed, secret-scanned, reviewed like code).                                      |

## Exit codes

| Code | Meaning                      |
| ---- | ---------------------------- |
| 0    | success / all checks passing |
| 1    | one or more checks failed    |
| 2    | usage error                  |

## Notes on read-only mode

The following commands write external state and refuse when
`KIT_READ_ONLY=1`:

- `secrets migrate` / `vault-migrate` / `rotate` / `set-value` / `pull --from`
- `auth elevate` (writes elevation marker)
- `hooks install` / `hooks add` / `setup`
- `fix` (writes .env.template, .gitignore, git hooks)
- `mcp set-token` (writes token store)
- Every plugin write surface — see `THREAT_MODEL.md` for the list

`kit check`, `secrets validate`, `env diff`, `mcp list`, and `audit`
are read-only and work in any mode.
