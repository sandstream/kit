# kit commands

> Complete reference for every `kit <subcommand>`. Generated 2026-06-08.
> Pair this with `docs/THREAT_MODEL.md` (what data flows where) and
> `docs/DATA_FLOW.md` (exact reads/writes per op).

## Global flags

| Flag | Effect |
|---|---|
| `--read-only` / `--readonly` | Activate session-wide refusal of every mutating op. Also honored as `KIT_READ_ONLY=1` env. |
| `--non-interactive` | Skip all confirmation prompts. Required in CI / agent contexts. |
| `--version` / `-v` | Print kit version + exit. |
| `--help` / `-h` | Print top-level help + exit. |

## Core lifecycle

| Command | Purpose |
|---|---|
| `kit init` | Auto-detect project stack → generate `.kit.toml` + lockfiles. |
| `kit setup` | 5-step orchestrator: install → hooks → login → secrets → check. |
| `kit check` | Verify tools / services / secrets / skills / hooks / security / tests. |
| `kit status [--json]` | Adoption checklist — which subsystems are set up (config, vault, tools, gitignore hygiene, dependency policy, agent-config, memory, hooks) + the next step for each gap. |
| `kit install` | Install missing tools declared in `[tools]` via mise. |
| `kit login [--service <name>] [--retry-count <N>]` | Guided login to configured services. Optionally narrow to one service / retry failures with backoff. |
| `kit login --plan [--json]` | Read-only: show the resolved auth strategy per service (vault / interactive / capture) + a passkey warning for browser logins that can't be scripted on a fresh machine. |
| `kit skills` | Check status of agent skills declared in `[skills]` against the registry (clawhub default). |
| `kit fix` | Auto-remediate common gaps (tools, lockfiles, gitignore, hooks, .env.template). |
| `kit upgrade` | Refresh lockfiles from `.kit.toml`. |
| `kit doctor` | Diagnostic sweep — surfaces config drift + CLI version skew. |
| `kit clone <url>` | Clone + setup in one step (skip setup with `--no-setup`). |

## Code quality + reviews

| Command | Purpose |
|---|---|
| `kit design` | A11y + design-token checks, baseline-aware. |
| `kit review` | Meta-runner — `check + design + tests` gate for PR. |
| `kit baseline [freeze]` | Snapshot current acceptable warnings to `.kit-baseline.json`. |
| `kit analyze [--write]` | Mine git history + framework markers → draft `CLAUDE.md` / `RULES.md`. |

## Secrets

| Command | Purpose |
|---|---|
| `kit secrets sync [--target=<github\|dotenv-ci\|stdout>]` | Sync vault → CI / `.env.local`. |
| `kit secrets migrate [--keep-commented \| --purge]` | Plaintext `.env*` → vault. Default leaves `KEY=` (value blanked). |
| `kit secrets vault-migrate --from <a> --to <b>` | Cross-vault key transfer (1Password → Infisical, etc.). |
| `kit secrets set <KEY> [--stdin \| --value <v>] [--store <backend>]` | Capture a value to the vault. `--stdin` (safer — not in argv/ps) or `--value`. Execution behind `auth = "capture"`. |
| `kit secrets rotate [--mode <jwt-secret-roll \| scoped-key-mint>]` | Rotate via supabase-mgmt-api. JWT roll is one-shot elevation. |
| `kit secrets onecli register` | Register fake-key in OneCLI gateway. |
| `kit secrets purge-history --force-history` | git-history rewrite to scrub leaked credentials. |
| `kit secrets propagate` | Sync vault → deploy platform (Vercel / Fly / etc.). |
| `kit secrets revoke-old` | Revoke superseded credential after rotation. |
| `kit secrets pull --from <vercel\|github\|fly\|cloudflare>` | Read env-vars from deploy platform into vault. |
| `kit secrets set-value <KEY> <VALUE>` | Write a single key/value to the configured vault. |
| `kit secrets validate [--fix\|--auto]` | Verify every declared key resolves in vault. `--auto` pulls from `.env.template`. |

## Auth + elevation

| Command | Purpose |
|---|---|
| `kit auth elevate [--scope <name>] [--ttl-minutes <N>]` | TTY prompt + TOTP → mints elevation marker for destructive ops. |
| `kit auth status` | Show current elevation state. |
| `kit auth revoke` | Clear elevation marker. |
| `kit auth setup-totp` | Enroll TOTP secret in `~/.kit/totp-secret`. |

## Environment

| Command | Purpose |
|---|---|
| `kit env list` | List configured environments (`[env.<name>]`). |
| `kit env switch <env>` | Activate env in `.kit/active-env.json`. |
| `kit env current` | Print active env. |
| `kit env diff --compare <other>` | Drift report between two `.env*` files (values shown as sha256:8 prefixes — never plaintext). |

## MCP orchestrator

| Command | Purpose |
|---|---|
| `kit mcp` / `kit mcp list` | Show declared MCPs + auth status. |
| `kit mcp status` | Alias for `list`. |
| `kit mcp auth <name>` | Show OAuth-flow guidance for vendor. |
| `kit mcp set-token <name> [--from-env VAR \| --paste]` | Headless / paste-token install. |
| `kit mcp clear <name>` | Remove stored token. |

## Hooks

| Command | Purpose |
|---|---|
| `kit hooks install` | Install pre-commit / post-commit hooks declared in `[hooks]`. Pulls in bypass-detector sentinel pair. |
| `kit hooks add <name>` | Add a built-in hook (secret-scan, post-pull-audit). |
| `kit hooks sync` | Reconcile installed hooks with config. |

## Security

| Command | Purpose |
|---|---|
| `kit security check-gitignore [--fix]` | Verify secret-file patterns are gitignored. |
| `kit security scan-staged` | Block commit if staged files contain credential patterns. |
| `kit security verify-pull [--base <ref>]` | Post-`git pull` audit: new deps, gitignore drops, introduced secrets. |
| `kit security scan-build [<dir>]` | Walk `.next` / `dist` for credential leaks in build artifacts. |
| `kit security clear-cache` | Wipe bumblebee cache. |
| `kit security costs` | Run cost-monitor leak-detection (P3.1). |
| `kit security policy` | Validate `.kit-allowlist.json` against current deps. |

## Triage (pre-install)

| Command | Purpose |
|---|---|
| `kit triage npm <pkg>` | Evaluate npm package: registry + GitHub health. |
| `kit triage npm <pkg> --sandbox` | + offline tarball inspection (install-script + path-traversal scan). |
| `kit triage pip <pkg>` | PyPI evaluation. |
| `kit triage docker <image>` | Docker image: CVE + sandbox. |
| `kit triage repo <github-url>` | GitHub repo evaluation. |
| `kit triage skill <path\|name>` | Claude Code / agent skill evaluation. |
| `kit triage all <target>` | Auto-detect + run all checks. |
| `kit triage tools` | List installed security tools. |
| `kit triage check-deps` | Pre-commit gate: fail if staged deps lack triage entries. |

## Packages + plugins

| Command | Purpose |
|---|---|
| `kit pkg install <pkg>` | Triage → install with pinned version. |
| `kit plugin search <query>` | Search plugin marketplace. |
| `kit plugin install <id>` | Install a plugin. |
| `kit plugin info <id>` | Plugin metadata. |
| `kit plugin scaffold <name>` | Generate a new plugin skeleton. |

## Governance

| Command | Purpose |
|---|---|
| `kit governance status` | Budget + revocation + agent info. |
| `kit audit` | Print recent `.kit-audit.jsonl` entries. |
| `kit whoami [--json]` | Show current agent / user identity, active environment, and budget usage. |
| `kit team create <name>` | Create a new team. |
| `kit team invite <email> [--role=<role>]` | Invite a user to the team (roles: owner, admin, developer, guest). |
| `kit team members list` | List team members. |
| `kit team member remove <email>` | Remove a team member. |
| `kit team audit log [--limit=<N>]` | View team audit logs. |

## Misc

| Command | Purpose |
|---|---|
| `kit open <service>` | Open service dashboard in browser (stripe, vercel, etc.). |
| `kit run <cmd>` | Arbitrary command runner (audit-logged). |
| `kit escalate` | Collect failures + format for manual handoff. |
| `kit ci` | One-shot CI gate (check + design + tests). |
| `kit context [--format json]` | Print kit context for agent introspection. |
| `kit create-plugin <name>` | Scaffold a new adapter. |
| `kit add <service>` | Add service to `.kit.toml`. |
| `kit version` | Print kit version + exit. |
| `kit completions <bash\|zsh\|fish>` | Output shell completion script for the given shell. |

## Memory

Local-first second brain — SQLite + FTS5, deterministic, zero model calls. Full guide: `docs/MEMORY.md`.

| Command | Purpose |
|---|---|
| `kit memory index` | Index `~/.claude` transcripts into `~/.kit/memory.db` (idempotent). |
| `kit memory search <query>` | Full-text recall; defaults to the current project, `--global` across all. |
| `kit memory stats` | Sessions / messages / tool-uses / DB size. |
| `kit memory suggest [--limit N] [--json]` | Emit a BYO-LLM review prompt (recent activity + open items) to stdout — pipe to your own model. kit never calls a model. |
| `kit memory install` / `uninstall` | Wire (or remove) the `UserPromptSubmit` + `SessionEnd` hooks in `~/.claude/settings.json`. |
| `kit memory scan` | Scan the store for stored secrets (masked; exits 1 if any found). |
| `kit memory backup <file>` / `restore <file>` | Encrypted AES-256-GCM backup/restore (`KIT_MEMORY_PASSPHRASE`). |
| `kit memory pal [list\|add\|done\|snooze\|verify\|import]` | Pending-action ledger; auto-closes on verify. Project-scoped (`--global` for all). |
| `kit memory save <name>` / `threads` / `resume <name\|n>` / `forget <name>` | Named copilots — bookmark + resume sessions. |
| `kit memory share …` / `areas` / `area <name>` | Shared, area-organized team memory (committed, secret-scanned, reviewed like code). |

## Exit codes

| Code | Meaning |
|---|---|
| 0 | success / all checks passing |
| 1 | one or more checks failed |
| 2 | usage error |

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
