# Changelog

All notable changes to kit are documented in this file. This project adheres to [Semantic Versioning](https://semver.org/).

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

## [1.8.0] - 2026-06-19

### Added
- **`kit heal` — bounded self-heal loop (detect → remediate → track, closed).** Loops over `kit check` findings: auto-applies the SAFE, deterministic, reversible fixes (install a missing scanner via mise, patch `.gitignore`) and re-scans until green, with PAL auto-close confirming each heal. Two classes are deliberately never auto-healed: **GATED** (secret rotation, history purge, propagate, `npm audit fix`) are proposed with the exact command but only the human/agent runs them, still through the elevation gate + audit log; **FAIL-CLOSED** (a supply-chain checksum mismatch = possible tampering) is surfaced loudly and refused, never auto-cleared, exiting non-zero — but it does not block applying unrelated safe fixes. `--dry-run` plans without changing anything; `--agent` emits the gated proposals as a structured block for an external agent to run (kit stays zero-LLM: it proposes, the agent executes). So an autonomous agent can drive an environment to green yet can never rotate a secret, rewrite history, or trust a tampered binary. (Refactor: the security→PAL bridge moved to `src/findings-track.ts`, shared by `kit check` + `kit heal`.)

## [1.7.0] - 2026-06-19

### Added
- **`kit check` findings are now tracked in the PAL ledger (the "track" layer).** Detect → remediate → **track**: each actionable security finding becomes an open `kind='finding'` item in the cross-session PAL ledger, so it surfaces as a reminder next session (via the existing SessionStart / prompt hooks) instead of scrolling past and being forgotten. The loop is self-maintaining: a finding the next scan no longer reports **auto-closes**, and one that cleared and recurs **reopens** — finding-presence itself is the verify, so no shell and no stored command (same security posture as the rest of PAL). Selective by design: only `fail`s plus `warn`s in security-relevant categories (secrets / exposure / supply-chain) become items — not every warn. Deterministic per-finding ids (`sec-<hash>`) make re-scans idempotent and reconciliation per-source. Opt out with `[memory] track_findings = false`. New core: `palSyncFindings` (src/memory/pal.ts); wired into `cmdCheck`, fail-open.

## [1.6.1] - 2026-06-19

### Fixed
- **`kit memory search` crashed on ordinary queries.** The raw query string was passed straight to SQLite FTS5 `MATCH`, where it is parsed as FTS5's own query *language* — so any term containing an operator char (`-`, `:`, `"`, `*`) or a bare `AND`/`OR`/`NEAR` threw `no such column: …` (e.g. `kit memory search "auto-close"`). Queries are now sanitized into a safe MATCH expression (each whitespace term double-quoted with embedded quotes escaped, prefix-matched, joined by implicit AND), so arbitrary text searches cleanly. Blank queries short-circuit to no results.

## [1.6.0] - 2026-06-18

### Added
- **`kit init` auto-detects the secret backend a repo already uses.** `.infisical.json` -> Infisical, `doppler.yaml`/`.doppler.yaml` -> Doppler. The detected store becomes the prompt default (and the non-interactive choice), instead of always defaulting to 1Password and hardcoding the wrong store in `--yes` runs.
- **`kit init` seeds `[secrets.keys]` from an existing `.env.example`.** Keys in `.env.example` / `.env.template` / `.env.sample` (e.g. `DATABASE_URL`, `OPENAI_API_KEY`, `JWT_SECRET`) are unioned into the generated config, deduped against the detected services' template keys, so a project's real secret contract is preserved rather than reduced to the handful kit has templates for.
- **`kit init` respects the repo's pinned runtime versions.** Node is resolved with precedence `.tool-versions` > Volta (`package.json#volta`) > `.node-version` / `.nvmrc` > `engines.node` > 22 (was: only `engines.node`, else 22); Python honours `.python-version` / `.tool-versions` (was: hardcoded 3.12). Stops kit from installing the wrong runtime on a brownfield repo.
- **More services in the registry:** Redshift, Redis/Upstash, Auth0 (just data rows, thanks to the registry).
- **Monorepo / workspace detection.** `kit init` now unions the dependencies of every workspace member before detecting framework + services, so a turborepo / pnpm-workspace whose `next`/`stripe`/`@supabase/supabase-js` live in `apps/*` or `packages/*` is detected from the root instead of coming up empty. Reads `package.json#workspaces` (array or `{packages}`) and `pnpm-workspace.yaml`; expands one-level `apps/*` style globs. Non-workspace repos are unaffected (byte-identical).
- **Native mobile + desktop stack detection.** `kit init` now recognizes mobile/native projects that have no `package.json`-with-web-framework: **React Native** (framework wins over plain react), **Flutter** (`pubspec.yaml` → dart), **iOS/Swift** (`Podfile` → framework `ios`, bare `Package.swift` → language swift for server-side Swift), and **Android** (`build.gradle`/`.kts` applying `com.android.*` → kotlin/android). Each gets a sensible `[setup]` (e.g. `flutter pub get`/`flutter analyze`, `pod install`, `./gradlew build`), and service detection runs for them too (a Flutter app using Firebase gets `firebase` wired). Generic JVM-Gradle and server-Swift are labelled by language without a mobile framework, to avoid mislabelling backends.
- **Data-driven service registry (init-v2 keystone) + cross-language detection.** Service detection and generation used to live in two hand-synced tables (`SERVICE_DETECTORS` in stack-detector, `SERVICE_TEMPLATES` in toml-generator), and the per-language detectors hardcoded `services: []`, so the whole secrets/login/tool layer was Node-only and adding a service meant editing two files. Both are now one `src/service-registry.ts` (`ServiceDef` per service: detection signals + login/check/secrets/tool/migrate), read by both the detector and the generator. Two payoffs: (1) a **Python/Go/Rust/PHP** repo that uses Stripe/Supabase/Sentry now gets those services detected (was always empty); (2) adding a service is **one data entry**. Seeded the previously-invisible stacks: **Convex, Firebase/Firestore, MySQL, PlanetScale, Neon, Turso, BigQuery, Snowflake**. Pure refactor for the existing 16 services (byte-identical `.kit.toml` output, all prior tests green); migrate precedence (supabase → prisma → drizzle) preserved via registry order.

## [1.5.0] - 2026-06-18

### Added
- **Choosing a vault now wires it up end-to-end (no more silent dead-end).** Picking a secret backend at `kit init` used to record `store = "…"` and nothing else — the CLI was never installed, no login was guided, and `kit secrets` then failed key-by-key with "CLI not available", leaving the user to guess why. Now the choice is fully provisioned: (1) the vault's CLI is added to `[tools]` so `kit setup` installs it via mise (Infisical/Doppler/Bitwarden/1Password/Vault; cloud secret managers ship their CLI via the cloud env, so they're guided but not provisioned); (2) the vault backends resolve that CLI **mise-first** — the same PATH dead-end that bit the scanners, since mise shims aren't on kit's PATH, so the binary kit just installed is actually found; (3) `kit init` prints the exact next steps the moment you choose (`kit setup` installs it; then `infisical login && infisical init`), and `kit secrets` raises a **loud, actionable flag** when a configured vault resolves zero secrets ("CLI isn't installed — run `kit setup`" vs "installed but not logged in — run `<login>`") instead of a column of silent ✗ lines. Infisical configs also get a scaffolded `[secrets.infisical]` binding block (`environment = "dev"` + a `project_id` pointer). Login stays the user's own account action — kit guides it, never runs it.
- **`kit setup` now installs project dependencies + runs the verify build (`[setup]` is no longer dead config).** The generated `[setup] install/migrate/verify` block had **zero** runtime consumers — `kit setup` provisioned the toolchain (node/pnpm via mise) but never ran `pnpm install`, so the repo wasn't actually working afterward and the block silently over-promised. Now `kit setup` runs `[setup].install` after the toolchain step and `[setup].verify` at the end (folded into the pass/fail gate). `migrate`/`seed` are **intentionally not auto-run** — a configured `supabase db push` / `prisma migrate deploy` can mutate a linked (possibly production) database — so they're surfaced with the exact command and run only behind `kit setup --with-migrate`. Commands with shell operators are refused (printed to run manually) rather than mis-split, per kit's no-shell exec invariant.
- **`kit init` offers to lock a brownfield repo's environment (`[context]`).** When a repo already talks to gcloud / Vercel / GitHub but declares no `[context]`, `kit init` now surfaces the detected account+project and offers to write the `[context]` lock (the same `gatherLive`/`suggestContextToml` the empty-state `kit context check` uses). kit does **not** install or authenticate these — it locks *which* account+project this repo is bound to, the exact pairing where cross-account contamination hides. Gated on a meaningful binding (gcloud account / Vercel project / GitHub org — not git-email/npm-registry alone, which are too noisy), defaults to **no** (the values are the currently-active CLI state, which the lock exists to question), and prints-only in non-interactive runs.
- **`kit check` adds an IaC misconfiguration scan (`trivy config`).** Distinct from the container-CVE scan: it flags insecure *infrastructure config* in Dockerfiles, Compose files, and Terraform (root user, privileged containers, public buckets, missing healthchecks, …). Runs only when IaC is present (Dockerfile/Compose/`.tf`), resolves trivy mise-first, and reports HIGH/CRITICAL as a warning. First of the 1.5.0 scanner-coverage round.
- **Deep secret scan on by default.** trufflehog is now a default mise-provisioned tool (`aqua:trufflesecurity/trufflehog`), and `kit check` resolves the `trufflehog` bin mise-first — so the deep secret scan runs out of the box instead of only when trufflehog happens to be on PATH. It scans **git** (`git file://.`, committed content) rather than the raw filesystem, so it's fast (skips `node_modules`), ignores gitignored local `.env*` (no false positives), and reports only real findings (filters trufflehog's info log line). Falls back to the basic regex scan when trufflehog can't be resolved.
- **Conditional scanner provisioning + OSV-scanner.** `kit init` now provisions scanners *only where they apply*: trivy (`aqua:aquasecurity/trivy`) when a Dockerfile/Compose is present, pip-audit (`pipx:pip-audit`) for Python, and osv-scanner (`aqua:google/osv-scanner`) for ecosystems with no dedicated scanner (go/rust/php/… — deliberately skipped for node/python to avoid duplicating `npm audit`/pip-audit). `kit check` gains an `osv-scanner` multi-ecosystem dep-CVE check (resolves mise-first; skips cleanly when absent). Completes the scanner-coverage round: every layer (deps · supply-chain · SAST · container · IaC · secrets) is covered, each ecosystem with one primary dep-CVE scanner.

### Security
- **`kit setup` hardens `.gitignore` before materializing `.env.local`.** The secrets step ([4/6]) writes `.env.local`, but `.gitignore` hardening lived only in the standalone `kit security check-gitignore --fix` / `kit fix` — never the default `setup`/`init` path. So on a repo whose `.gitignore` lacked `.env.local` (common — many only ignore `.env`), kit wrote real secrets into a file the next `git add .` would stage, violating its own "secret-safe" promise. `kit setup` now patches `.gitignore` (idempotent, repo-local append) right before the secrets step and announces it. The standalone command remains for the manual path.

## [1.4.3] - 2026-06-18

### Added
- **`kit setup --recommended` — opinionated, batteries-included profile.** After the core pipeline it wires the cross-harness **memory hooks**, a **pre-commit secret-scan** gate, and a **pre-push context-check** gate (only when `[context]` is declared) — using the hardened installers (absolute-path memory hooks; hooksPath-aware, no-clobber, absolute-`kit` git hooks). It announces up front that it touches `~/.claude` and the repo's git hooks. So one command takes a repo from clone to a fully-wired, agent-runnable, self-checking environment. Interactive `kit setup` now **asks** whether to use the recommended profile (default yes); `--recommended` / `--minimal` are the non-interactive answers to that question, and CI/agents without a flag get the core setup (never silently wiring global `~/.claude` hooks). Plain `kit setup` now *also* grants the read-only kit permission allowlist in `[5/6]` (previously only `kit agent-config` did), so the agent can run kit after setup.

### Fixed
- **`kit check` finds mise-installed scanners (socket, semgrep, trivy).** The security step looked for them with a bare PATH lookup, so a scanner installed via mise — whose shims aren't on kit's own PATH — was reported "not installed" even when present. A new `resolveToolBin` resolves mise-first (`mise which`) then PATH; check-security uses it for all three. Groundwork for managing them as default mise-provisioned scanners. (trivy stays container-conditional — it only runs when a `Dockerfile` is present.)
- **`kit memory install` writes hooks that actually run.** Hooks were written as a bare `kit memory hook …`, but Claude Code runs hooks in a non-login `/bin/sh` whose PATH usually does **not** include the npm global bin (`~/.npm-global/bin`, nvm/volta/pnpm shims, …). So the hook failed with `kit: command not found` and **silently broke memory capture** — the store looked installed but recorded nothing live. Install now pins an absolute `<node> <cli.js>` invocation resolved from the running process, matches existing hooks by suffix (so re-install dedupes and uninstall cleans up legacy bare entries), and **warns loudly** if it cannot resolve an absolute path instead of failing silently.

### Added
- **`kit init` provisions security scanners by default.** Generated `.kit.toml` now includes semgrep (`pipx:semgrep`) and socket (`npm:@socketsecurity/cli`) in `[tools]`, so `kit setup`'s install step provisions them via mise and `kit check` runs them out of the box (paired with the mise-aware resolution that finds them). They were "optional/not installed" before; now they're on by default like the built-in scanners. Remove from `[tools]` to opt out. (socket's deep scan still needs `socket login`; semgrep pulls a Python toolchain via pipx.)
- **`kit agent-config` now lets the agent actually *run* kit.** Teaching an agent to "use kit" is useless if every `kit …` hits the permission wall in auto/non-interactive mode — the agent gets blocked and silently never runs it. `agent-config` now merges the **read-only** kit commands (`check`, `status`, `doctor`, `ci`, `analyze`, `escalate`, `context check`, `triage`, `memory search`/`stats`/`index`) into the project's `.claude/settings.json` `permissions.allow`. Idempotent and non-destructive — preserves your other rules, only grants read-only commands (secrets/fix/hooks/agent-config keep prompting), and **never** writes a `deny` rule or sets a bypass mode.
- **`kit agent-config` now teaches agents about memory.** The managed "use kit" block injected into CLAUDE.md / AGENTS.md / .cursorrules / .clinerules gains a bullet: recall prior decisions with `kit memory search "<query>"` (cross-session, cross-agent) and keep the store current with `kit memory index`. Previously the block covered check/triage/secrets/elevate but never mentioned the memory store, so agents in a kit repo had no pointer to it. Also refreshed the README's memory command summary (was missing `stats`, `merge`, `save`/`threads`).

## [1.4.2] - 2026-06-17

### Fixed
- **`kit <command> --help` shows help instead of running the command.** A `--help`/`-h` after any top-level command fell through to the dispatch and *executed* the command — harmless for read-only ones, but `kit agent-config --help` would inject its rules block, and `fix` / `secrets` / `hooks add --help` would run their side effects. The main dispatch now intercepts `--help`/`-h` for any command and prints that command's help (generalizes the 1.4.0 fix that only covered `kit memory <sub> --help`).
- **Informational services are a warning, not a failure, in `check` / `ci` / `escalate`.** A service whose login is `#`-documented (no CLI — e.g. resend "set `RESEND_API_KEY`", sentry "get DSN") was reported as `✗ fail`, dragged down the overall gate, and `escalate` printed a nonsensical `Run: # resend …`. It now shows as a `warn` / "manual setup (no CLI login)", does not fail the gate, and `escalate` shows the documentation message. (Extends the 1.4.1 `manual` login state to the check/ci/escalate paths.)
- **`kit security scan-build` no longer false-positives on framework manifests.** Terraform/tfstate finding labels (`tfstate-value`, `terraform-sensitive`) are filtered out of build-artifact scanning, so a Next.js `routes-manifest.json` `"value":"…"` route entry is no longer reported as a potential secret. Real inlined credentials (Stripe/JWT/AWS/…) are still caught.
- **`kit memory status` now aliases `kit memory stats`** (was "unknown subcommand").
- **`kit review`, `kit design`, and `kit baseline` now have help text** (`kit <cmd> --help` / `kit help`).

### Security
- **Encrypted backup passes an explicit `authTagLength` (16) to `createCipheriv`/`createDecipheriv`.** The GCM auth tag was already fixed at 16 bytes (`setAuthTag` + `final()`), so this is a hardening assertion that also clears the Semgrep `gcm-no-tag-length` finding that was blocking the "Security — Full App Scan" workflow.

## [1.4.1] - 2026-06-17

### Added
- **`kit memory stats` shows a per-harness session breakdown** (e.g. `claude-code 212, codex 1`) — the portability proof that the externalized store spans agents, not one tool, so you can pick up the same context from a different harness. Included in `--json` as `byHarness`. Also corrected the `kit memory index` help, which undersold itself as "~/.claude transcripts" though it indexes every supported harness (Claude Code, Codex, Gemini, Cursor, …).
- **`kit context check` empty-state now suggests a `[context]` block detected from the repo.** Instead of a bare "add one" line, it prints a ready-to-paste block built from the live context, annotated by source: git/github/vercel come from repo-local truth (git config, origin remote, `.vercel/project.json`) and are marked authoritative; gcloud/npm are ambient/global and flagged "VERIFY this is right for THIS repo" — because the whole point of the lock is that the currently-active account/project is what must be questioned, not trusted. Tables kit cannot read are omitted. (`suggestContextToml`, pure + unit-tested.)
- **Quick start + Prerequisites** in the README and `kit --help`. Lists Node 22+, git, and [mise](https://mise.jdx.dev) (used to install the tools in `[tools]`), the npx vs global-install paths (incl. the user-prefix fix for `npm -g` permission errors), and the first-run command sequence (`init → check → setup → context check`). `kit --help` now leads with a "Get going" line.

### Fixed
- **`kit hooks` installs into the directory git actually runs hooks from, and never clobbers a foreign hook.** Hook install hardcoded `.git/hooks`, which git ignores entirely when `core.hooksPath` is set (husky, lefthook, a committed `.githooks/`) — so an installed gate like `context-check` reported `✓ installed` but **silently never ran** (false security). `resolveHooksDir` now honors `core.hooksPath`. And because that means kit may target a directory holding the operator's own committed hooks, install now **skips an existing hook it did not generate** (no `Generated by kit` marker) with guidance to merge or remove it, instead of overwriting it wholesale and dropping whatever it enforced.
- **`[context]` no longer triggers a spurious "unknown section" warning.** The config validator's known-section allowlist omitted `context` (added in 1.4.0), so every `kit context` run warned about the very section it reads.
- **Auth-status detail is a single redacted line.** `kit login` / `kit check` showed a service's full multi-line check-command output as its status detail — for `stripe config --list` that meant a verbose dump of account metadata (account IDs, display names for *every* configured account) spread across the status table. (Credential *values* were already masked by `redactSecrets` at the check source, so this was noise + metadata exposure, not a key leak.) Output now collapses to the first non-empty line, length-capped, via a new `safeStatusLine` helper applied at every display site — `kit login`, the `kit check` Services table (`output.ts`), and `--json`. `safeStatusLine` re-runs the canonical `redactSecrets`, which also closes a gap where `login.ts`'s post-login verify did not redact its own output.
- **`kit secrets` no longer clobbers a working `.env.local`.** When the vault resolved zero secrets (e.g. Infisical unauthed), `generateSecrets` overwrote an existing `.env.local` with an empty comment-only scaffold, destroying local-dev credentials. It now skips the write and leaves the file intact when nothing resolved (it still writes a scaffold when no file exists yet).
- **Services with no CLI login show as "manual", not "failed".** A service whose `.kit.toml` `login` is informational (`# … set X in env`, e.g. resend, sentry) is expected manual setup — it no longer counts as a login failure, and is no longer pointlessly retried with backoff on every `kit setup`.
- **Clear message when mise is missing.** `kit setup` / `kit install` now says "mise is not installed — install with `brew install mise` (or `curl https://mise.run | sh`)" instead of surfacing a raw `spawn mise ENOENT`. kit uses mise to install and pin tool versions; if it is absent, the failure is now actionable.
- **Surface mise's real error instead of "Command failed".** When `mise install` fails, kit now reads mise's stderr and shows the concrete `mise ERROR …` line. It specifically detects an untrusted `.mise.toml` (mise refuses to run until `mise trust`) and tells you to review the file and run `mise trust` — previously this surfaced only as an opaque `Command failed: mise install …`.

## [1.4.0] - 2026-06-17

### Added
- **`kit context check` — per-project CLI context lock.** Declare each tool's exact account + project in `.kit.toml` `[context]` (gcloud account/project, vercel team/project, github org/remote, git email, npm registry). `kit context check` reads the LIVE tool state and verifies it matches, and **never infers a pairing from whatever happens to be logged in or selected**: a right account with the wrong project is a mismatch, not a pass. Read-only; exits non-zero on a mismatch so it can gate a git hook or an agent before an outward or destructive command. Context pointers are non-secret and live in config; the credentials they authenticate with stay in the vault. (Catches the class of incident where a repo carries a stale deploy connection from a previous purpose, or a CLI is pointed at the wrong org.)
- **`kit hooks add context-check`** — installs a `pre-push` git hook that runs `kit context check` and blocks the push on a mismatch. This is the enforcement: a push to the wrong org/project is stopped before it leaves the machine.
- **`kit context use`** — activates the declared context (gcloud config + repo git identity) so every CLI points at the right account/project atomically. Touches only local config, never an account or a deploy; vercel/npm get guidance rather than an auto-switch.
- **`kit context --prompt`** — a fast, read-only indicator of the active gcloud context (e.g. `[gcp:my-project]`) for your shell prompt, read from gcloud's config files (no subprocess per prompt), so the context you are in is always visible.
- **Rule citations on security checks.** Each `kit check` security finding now carries the rule it enforces (CWE / OWASP Top 10) in the `--json` output and as a `[CWE-…]` tag in the text table, via a local, deterministic rules catalog (`src/rules/catalog.ts`). It cites kit's own checks (gitignore, secrets, dep-pinning, lockfiles, service exposure); a check without a defensible anchor carries no rule rather than a forced one. Foundation for consolidating + citing findings across kit and the scanners it wraps.

### Changed
- **`kit memory pal add` verify flags:** use `--verify-http <url> [--expect <code>]` or `--verify-file <path>` instead of `--verify "<shell>"`. For checks these types do not cover, run the check yourself and close the item manually (pal stays a ledger). Raw shell `verify_cmd` from pre-1.4 stores is retained so `kit memory scan` can still find secrets in old rows, but is never auto-executed.

### Fixed
- **A `--help`/`-h` flag never executes a side-effectful subcommand.** `kit memory <subcommand> --help` (e.g. `kit memory install --help`) previously ran the subcommand instead of printing help, so `kit memory install --help` would actually install the hooks. It now shows help and does nothing else.

### Security
- **PAL verify is now a declarative, typed check instead of a raw shell command.** `palAutoVerify` no longer runs a stored shell string through `execSync`; it runs a typed check natively (`http-status` via fetch, `file-exists` via fs), never through a shell and never by interpolating a stored value into a command. There is no longer an arbitrary-command-execution sink. This removes a persistence/deferred-execution risk that mattered for kit's agent-native use: a prompt-injected agent could previously store a `verify_cmd` in one (low-trust) session that detonated later when a more-trusted session ran `kit memory pal verify`. The typed model is also deliberately autonomy-friendly: auto-verify needs no human gate, yet a planted or injected value is inert (a defensive parser rejects any unknown shape). Closes the residual `memory/pal.js` finding (Socket AI) at the root rather than by adding a human-in-the-loop gate that would break autonomous agent jobs.

## [1.3.1] - 2026-06-17

### Security
- **PAL: a `verify_cmd` from a file or another machine's DB is never auto-executed.** `kit memory pal` auto-verify runs an item's `verify_cmd` through the shell to auto-close pending actions. That executable command is now only ever created by `pal add` (operator-authored in the current session). Both external-source paths now demote incoming items to `kind='manual'` with no `verify_cmd`: `importLegacyLedger` (reads a JSONL whose path is overridable via `KIT_PAL_LEDGER`) and `kit memory merge <other.db>`. So a command that crossed a file or DB boundary can never auto-run; re-add via `pal add` to re-enable auto-verify. This closes a backdoor-like arbitrary-command-execution vector in adversarial agent/CI contexts (flagged by Socket's AI analysis on `memory/pal.js`). Added a regression test asserting an imported `verify` never executes.

## [1.3.0] - 2026-06-16

### Added
- **Three more memory harnesses** — `kit memory index` now also reads **Cursor** (`globalStorage/state.vscdb`), **Amazon Q Developer CLI** (`amazon-q/data.sqlite3`), and **Cline** (VS Code `saoudrizwan.claude-dev/tasks/*/api_conversation_history.json`), bringing the source-verified set to seven: Claude Code, Codex, Gemini, Continue, Cursor, Amazon Q, Cline. Each parser is built against the agent's own serialization format (verified from source or community readers), never guessed; the Cursor + Amazon Q SQLite parsers are **defensive** — they map only known fields and index nothing if the shape ever differs, so they can never write wrong data. GitHub Copilot CLI, Google Antigravity, Zed, and Kiro stay out until their formats are source-verifiable (Copilot: no schema/stability contract per [copilot-cli#3551](https://github.com/github/copilot-cli/issues/3551); Antigravity IDE: binary protobuf, no public `.proto`; Zed: LMDB store, would need a native dep; Kiro: closed-source/undocumented).
- **`kit memory suggest [--limit N] [--json]`** — opt-in, BYO-LLM memory review that **preserves the zero-LLM core**: kit never calls a model. It deterministically gathers the current project's recent activity + open action items and emits a structured prompt to stdout for *your* model to propose new `pal` items / shared-area entries — `kit memory suggest | <your-llm>`. Accepted proposals are recorded via `kit memory pal add` / `kit memory share`.
- **Per-service auth strategies** — services may declare `auth = "vault" | "capture" | "interactive"` in `.kit.toml`; when omitted it's inferred (interactive if a `login` command exists, else vault). `kit login --plan` (read-only, `--json` supported) shows the resolved strategy per service plus a passkey/browser warning for logins that can't be scripted on a fresh machine (gh, vercel, cloudflare, …). The deterministic resolver lives in `service-auth.ts`.
- **`kit secrets set <KEY>`** — capture-to-vault: write a user-provided value to the configured vault via `--stdin` (safer — not in argv/ps) or `--value`. This is the execution behind a service's `auth = "capture"` strategy; it reuses the existing `setSecretValue` path so the secret is never echoed or logged. Exposes a vault-write that previously had no CLI surface.

### Fixed
- **`kit open` / `openInBrowser` no longer spawns a browser in non-interactive/CI/test runs** — it now honors `isNonInteractive()` and prints the URL instead (mirroring `login.ts`). This stopped the test suite from popping the Stripe dashboard window during `npm test` (Stripe was the only service whose dashboard auto-opened). `npm test` now also runs with `KIT_NON_INTERACTIVE=1`, and the open suite forces it itself for hermeticity.
- Stopped shipping cloud-sync conflict copies (`* 2.js`) in the published package — deleted the stale `* 2.ts` source duplicates and added a `tsconfig` `exclude` + `.gitignore` guard so they can't recompile into `dist/` or be committed again. (They had leaked into the 1.2.0 tarball.)

## [1.2.0] - 2026-06-16

### Added
- **Multi-harness memory** — `kit memory index` pulls transcripts from every supported coding agent on the machine, each tagged with a `harness` so recall spans them: **Claude Code** (`~/.claude`), **Codex** (`~/.codex/sessions`), **Gemini CLI** (`~/.gemini/tmp`), and **Continue.dev** (`~/.continue/sessions`). New `indexAllHarnesses()` registry with per-harness counts in the index report. Each parser is built against the agent's own serialization format (verified from its source), never guessed; absent agents are skipped silently. Adding a harness is a single parser. (Cursor, Amazon Q, and Cline followed in 1.3.0.)
- **`kit status [--json]`** — a deterministic cross-subsystem adoption checklist: which subsystems are set up (config, secrets vault, tools, gitignore hygiene, dependency policy, agent-config, memory, hooks) plus a rule-based next step for each gap. No inference — every signal is read from real local state.
- **SessionStart recovery hook** — a third fail-open memory hook that re-injects the current project's most-recent messages + open action items after a resume/compaction, so a session regains continuity instead of starting blank. Wired by `kit memory install` alongside `UserPromptSubmit` + `SessionEnd`.
- **`kit memory merge <other.db>`** — consolidate another machine's memory store into this one (idempotent, dedup by message uuid) — e.g. folding a laptop's history into a workstation's.
- **Google web-search provider** — `kit check`'s web-search probe now runs a real Custom Search JSON API health check (config `apiKey` + `cx`), replacing the previous not-implemented stub.

### Changed
- **Incremental indexing** — `kit memory index` skips transcripts unchanged since the last run via a new `file_index` table (mtime + size), with the per-message uuid dedup as a backstop. Re-indexing a large history is now near-instant.

## [1.1.0] - 2026-06-16

### Added
- **`kit memory`** — a local-first, deterministic second brain (SQLite + FTS5, zero model calls, two fail-open hooks). Index `~/.claude` transcripts, project-scoped full-text `search`, `UserPromptSubmit` reminder + `SessionEnd` sync, encrypted `backup`/`restore` for disaster recovery, `scan` for secrets stored in the DB, a pending-action ledger (`pal`, auto-closes on verify), named-copilot bookmarks (`save`/`threads`/`resume`), and a curated, area-organized, secret-scanned shared team tier (`share`/`areas`/`area`). See [`docs/MEMORY.md`](docs/MEMORY.md). Schema + two-hook design credited to [cloudctx](https://github.com/chadptk1238/cloudctx) (MIT).

## [1.0.1] - 2026-06-14

### Changed
- Documentation and packaging cleanup ahead of the public release.

> Public versioning for `sandstream-kit` starts at **1.0.0** — the first published release. Entries below this point document the unpublished `sandstream-kit` development lineage and are kept for internal traceability.

## [1.1.0] - 2026-05-30

### Added
- **Full-app security workflow** (`.github/workflows/security.yml`) with 9 gating stages: deps (npm audit + Snyk), supply-chain (bumblebee), SAST (ESLint + Semgrep + SonarCloud), DAST (ZAP — scoped out for CLI), container (Trivy CRITICAL+HIGH SARIF), infrastructure (Checkov + tfsec), secrets (gitleaks), GDPR + headers, kit self-check, plus aggregated gate
- **Agent-hook templates** (`examples/agent-hooks/`) for Claude Code (PostToolUse), Codex (AGENTS.md + MCP), Cursor (.cursorrules + .cursor/mcp.json), Cline (.clinerules + MCP autoApprove). Cross-provider git pre-commit fallback documented in `examples/agent-hooks/README.md`
- Supply-chain exposure scanning via [bumblebee](https://github.com/perplexityai/bumblebee)
  - New `supply-chain` security check in `kit check` / `kit ci` that flags installed packages matching curated known-compromise catalogs (Shai-Hulud, typosquats, credential stealers, malicious editor/browser extensions, MCP servers)
  - Pinned release binary auto-downloaded and SHA-256-verified (no Go toolchain needed), cached under `~/.kit/tools/bumblebee/<version>/`
  - kit Action scans the checked-out repo in CI (`deep --root .`); local runs scan the machine baseline
  - Tunable via `KIT_BUMBLEBEE`, `KIT_NO_DOWNLOAD`, `KIT_BUMBLEBEE_PROFILE`, `KIT_BUMBLEBEE_ROOTS`, `KIT_BUMBLEBEE_BIN`, `KIT_BUMBLEBEE_CATALOG`
- Phase 5F: Public Launch & Community infrastructure
  - CODE_OF_CONDUCT.md for community standards
  - CHANGELOG.md for release tracking
  - COMMUNITY.md for contribution guidelines
  - GitHub issue templates for bug reports and feature requests
  - GitHub discussions setup guide
- Phase 5E: Security Framework & Hardening
  - SECURITY.md with comprehensive security audit checklist
  - SECURITY-HARDENING.md with pre-deployment verification procedures
  - SECURITY-SCANNING.md with automated security scanning pipeline
  - 5-stage security scanning (dependencies, SAST, DAST, containers, infrastructure)
  - GDPR and data protection compliance validation
  - Security incident response procedures
- Phase 5D: Load Testing & Performance
  - k6 load testing infrastructure with baseline, marketplace, and autoscaling tests
  - Database stress testing and connection pool validation
  - Bottleneck analysis methodology and optimization strategies
  - Capacity planning guide with 3 scaling scenarios and cost analysis
  - Kubernetes autoscaling validation test

### Changed
- Enhanced security monitoring and alerting infrastructure
- Improved deployment pipeline with security gates
- Extended monitoring capabilities with Prometheus metrics

### Fixed
- npm audit highs: fast-uri (path traversal + host confusion) and next 16.2.6
- pre-existing master CI failures
  - `src/run.test.ts`: isolated-env test now uses `process.execPath` (exit 127 → 0)
  - `src/audit-logging-service.test.ts`: 4 compliance-report window races (capture `end` after recording)
  - `Dockerfile`: dumb-init path /usr/sbin → /usr/bin; ENTRYPOINT includes node + cli so args pass through
  - `Dockerfile.marketplace`: drop redundant nginx-user (UID 101 conflict with built-in)
  - `marketplace-frontend`: add lucide-react dep; swap missing `ShieldStar` → `Award`; widen team-members `newRole` type
  - `docker-build.yml`: SHA-tag prefix bug (`:-<sha>`), GHA cache for PR builds (no creds), conditional Docker Hub push when DOCKER_* secrets absent, `pull-requests: write` for PR-comment step
- workflow shell-injection (Semgrep): `deploy-production.yml`, `deploy-staging.yml`, `action/action.yml` — untrusted inputs moved to step `env:`, tag/cmd allowlists added
- gitleaks false-positive on `${ENV_VAR}` placeholders in config files

### Security
- 65% Checkov reduction (166 → 58 terraform findings, 64 → 32 distinct check IDs) — see `.checkov.yaml` baseline header for fix log
  - SG descriptions, ECR `IMMUTABLE`, CW log KMS + 365d retention, S3 abort-multipart, EKS supported version 1.31, EKS Secrets envelope encryption, KMS key policies, VPC flow logs, default-SG lockdown, ELBv2 access logs, RDS Performance Insights KMS (per region), NLB log bucket hardening, public-subnet auto-IP off, EKS private-endpoint default, RDS replica deletion-protection + enhanced monitoring, SNS KMS, RDS IAM auth, Lambda X-Ray + DLQ + KMS, EC2 IMDSv2 + EBS-opt, CloudFront response-headers policy, scoped Lambda IAM, RDS SSL-required, copy_tags_to_snapshot
- DAST stage scoped out: kit is CLI + MCP-over-stdio with no HTTP surface to scan
- Comprehensive security scanning across all pipeline stages (Phase 5E carry-over)
- OWASP Top 10 vulnerability assessment and remediation
- Container vulnerability scanning with Trivy (CRITICAL+HIGH gating)
- Infrastructure-as-code security scanning (Checkov + tfsec) with baseline file
- Rate limiting and DDoS protection
- Security headers validation

## [1.0.0] - 2026-04-15

### Added
- Phase 5C: DevOps & Deployment Infrastructure
  - Multi-stage Docker containers for CLI and marketplace
  - Kubernetes manifests with Kustomize overlays for dev/staging/prod
  - Terraform modules for complete infrastructure-as-code
  - GitHub Actions workflows for Docker builds and Kubernetes deployments
  - Horizontal Pod Autoscaling (HPA) with CPU/memory triggers
  - Pod Disruption Budget (PDB) for high availability
  - Service mesh integration (optional)
  - Monitoring stack (Prometheus + Grafana)
  - Logging aggregation (Fluent-bit + CloudWatch/ELK)
  - Certificate management with cert-manager
- Phase 4: Integration & Developer Experience
  - Sentry integration for error tracking
  - Datadog integration for APM and monitoring
  - Redis adapter for caching
  - CDN adapter for static asset acceleration
  - Testing framework enhancements
  - Error handling and recovery patterns
- Phase 3E: Author Dashboard
  - Backend implementation with 43 new tests
  - Frontend with 6 components and 4 pages
  - Community features foundation
- Phase 3: Marketplace
  - 4 core marketplace components (marketplace, storefront, listings, reviews)
  - 716 comprehensive tests
  - Plugin review and rating system
  - Search and filtering capabilities
  - User profiles and favorites
- Phase 2: Plugin Ecosystem
  - 10 ecosystem components (registry, resolver, security validator, etc.)
  - Plugin manifests and versioning
  - Dependency resolution
  - Security scanning
  - Plugin marketplace integration
- Phase 1: Core CLI
  - kit command-line interface
  - Tool management (mise-en-place integration)
  - Secret management (1Password integration)
  - Project setup and initialization
  - Configuration management (.kit.toml)

### Security
- Implemented comprehensive security framework (OWASP Top 10)
- Added dependency vulnerability scanning
- Enabled container image scanning
- Infrastructure security hardening
- GDPR and data protection compliance

---

## Release History Summary

| Version | Date | Phase | Highlights |
|---------|------|-------|-----------|
| 1.0.0 | 2026-04-15 | 5C | DevOps & Deployment Infrastructure |
| - | In Progress | 5F | Public Launch & Community |

## Semantic Versioning

### Version Format: MAJOR.MINOR.PATCH

- **MAJOR** — Breaking changes (incompatible API changes)
- **MINOR** — New features (backward compatible)
- **PATCH** — Bug fixes (backward compatible)

### Examples
- 1.0.0 → 1.1.0: New feature added
- 1.0.0 → 1.0.1: Bug fix
- 1.0.0 → 2.0.0: Breaking change

## Release Process

### Before Each Release

1. Update CHANGELOG.md with changes since last release
2. Update version number in package.json
3. Create git tag: `git tag -a v1.0.0 -m "Release 1.0.0"`
4. Push tag: `git push origin v1.0.0`
5. GitHub Actions automatically builds and publishes

### Release Naming

- **Alpha (α)** — Early development, breaking changes expected
  - Example: v1.0.0-alpha.1
  - Testing by developers only
  
- **Beta (β)** — Feature-complete, bug fixes and polish
  - Example: v1.0.0-beta.1
  - Limited community testing
  
- **Release Candidate (RC)** — Preparation for release
  - Example: v1.0.0-rc.1
  - Final testing before release
  
- **Stable (Release)** — Production-ready
  - Example: v1.0.0
  - Recommended for production use

## Long-Term Support (LTS)

- **Current stable:** v1.x.x (released 2026-04-15)
- **Support period:** Until next major version (typically 12+ months)
- **Security updates:** Available throughout support period

## Migration Guides

- [Upgrading from Phase 4 to Phase 5](docs/MIGRATION_GUIDE.md)
- [Breaking Changes in v2.0.0](docs/API_STABILITY_AND_VERSIONING.md) (future)

## Contributors

Special thanks to all contributors who have helped shape kit:

- [View Contributors](https://github.com/sandstream/kit/graphs/contributors)

## Reporting Issues

Found a bug? Have a feature request? Please see our [CONTRIBUTING.md](CONTRIBUTING.md) guide.

---

**Note:** This changelog is maintained manually and should be updated with each release. Unreleased changes are accumulated and released with the next version.
