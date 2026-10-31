/**
 * Help for multi-word sub-commands (e.g. `kit memory search`). Help-only: no dispatch handler or
 * stability tier of their own; cli.ts merges these into COMMAND_HELP, which `kit <cmd> <sub> --help`,
 * `kit help <cmd>` and contracts/kit.opencli.json all read.
 *
 * Kept out of cli.ts so the table can cover every dispatched subcommand without growing the entry
 * point. src/subcommand-help.test.ts fails when a `kit <cmd> <sub>` row in docs/COMMANDS.md has no
 * entry here, which is how 46 of them had come to print only their parent's one-liner.
 */
export const SUBCOMMAND_HELP: Record<string, string> = {
  "check verify-attestation": "Verify a signed .kit-check-attestation.json receipt",
  "check compare":
    "Diff two `kit check --json` runs — what changed, with lost coverage ranked above a regression",
  "airgap verify":
    "Prove zero-egress: assert every scanner that would run air-gapped resolves to a local artifact (no cloud-only, no registry semgrep config)",
  "profile show": "Render the declared project profile with per-line reconciliation marks",
  "profile freeze":
    "Snapshot the discovered toolchain into .kit-profile.toml (preserves operator-authored workflows/plugins/scope/gates)",
  "profile check":
    "Report declared-vs-discovered drift (--gate fails CI on any drift; honest skip when no profile declared)",
  "profile sign":
    "Sign the profile (scope/RoE) into .kit-profile.sig via your identity/keystore — offline-verifiable",
  "profile verify":
    "Verify .kit-profile.sig offline (--key pin → local identity → org .kit-policy.signers)",
  "profile export":
    "Export a portable signed bundle (profile + signature + signer key) to --out or stdout",
  "profile import":
    "Import a portable bundle on a fresh host — integrity-verify offline, fail-closed on tamper/revoked (authoritative only once the signer is anchored)",
  "broker enforce-readiness":
    "Read the recorded observe window (.kit-audit.jsonl) and report whether it's safe to flip exec-broker to enforce: ready | would-block (+ exactly what breaks) | untested (--gate fails CI on any not-ready verdict)",
  "broker enforce":
    "Guided observe→enforce flip: readiness pre-flight (refuses unless ready; --force overrides), set [scope].enforce_runtime = true, re-sign the profile scope, and audit the transition",
  "browser doctor":
    "Diagnose browser-verification readiness from [browser], selecting Playwright, system Chrome, CDP, or a blocker (--json)",
  "browser status": "Print the selected browser strategy and top-level verdict (--json)",
  "browser cdp-url":
    "Print the detected Chrome DevTools Protocol URL, if one is configured or reachable (--json)",
  "browser playwright-env":
    "Print shell exports for browser test runners (--json emits the same env object)",
  "memory index": "Index every supported agent transcript into the SQLite memory store",
  "memory search":
    "Full-text search memory (current project; --global for all; --fresh = recency-aware ranking)",
  "memory stats": "Show what the local memory store contains",
  "memory project":
    "Show or initialize the checked-in project identity used for cross-clone recall",
  "memory suggest":
    "Emit a BYO-LLM review prompt (recent activity + open items) — pipe to your own model",
  "memory merge": "Merge another machine's memory.db into this one (dedup by uuid)",
  "memory sync":
    "Import a memory export or encrypted backup (task descendants advance, concurrent alternatives retained; file_index excluded)",
  "memory install":
    "Wire Claude Code prompt/start/end hooks and silent Codex start/end hooks into lifecycle config",
  "memory scan":
    "Scan the memory store for stored secrets, or prompt-injection patterns with --injection (exit 1 on a high-confidence finding)",
  "memory backup": "Encrypted backup of the memory store (AES-256-GCM; KIT_MEMORY_PASSPHRASE)",
  "memory restore": "Restore an encrypted memory backup (e.g. on a new machine)",
  "memory share": "Promote a curated, secret-scanned entry to the shared (team) memory",
  "memory areas": "List shared responsibility areas (stripe, whatsapp, …)",
  "memory area": "Show shared entries for one area (decisions, how-built, status, security)",
  "memory context":
    "Push-surface active decisions for the area(s) whose files you're touching (deterministic, path→cluster)",
  "memory pal":
    "Pending action ledger — list/show/add/configure/claim/renew/takeover/release/reopen/done/snooze/resolve/forget/verify/import/prune",
  "memory pal claim":
    "Claim inspected work: kit memory pal claim <id> [label] --harness <name> --session <id> --expect <frontier>",
  "memory pal renew":
    "Renew owned work and receive a new frontier: kit memory pal renew <id> --harness <name> --session <id> --expect <frontier>",
  "memory pal takeover":
    "Explicitly take over claimed work: kit memory pal takeover <id> [label] --harness <name> --session <id> --expect <frontier> [--take <head>] (required for multiple heads)",
  "memory pal configure":
    "Configure a local verifier: kit memory pal configure <id> (--manual | --verify-file <path> | --verify-http <url> [--expect <code>])",
  "memory pal show":
    "Inspect causal task state without writes: kit memory pal show <id> [--history] [--json]",
  "memory pal resolve":
    "Resolve observed alternatives: kit memory pal resolve <id> --expect <frontier> (--take <revision> | --state <file>) [--harness <name> --session <id>] (contested claims require takeover)",
  "memory pal forget":
    "Erase a task and its history with a sync tombstone: kit memory pal forget <id> --expect <frontier> [--harness <name> --session <id>] [--json] (claimed work requires its owner)",
  "memory save": "Bookmark the current session as a named copilot",
  "memory threads": "List saved copilots (current project; --global for all)",
  "memory resume": "Print the resume command for a saved copilot (by name or number)",
  "login --plan":
    "Show the resolved auth strategy per service (vault/interactive/capture + passkey) without logging in",
  "secrets sync": "Push resolved secrets to GitHub Actions / .env.ci / stdout",
  "secrets migrate": "Migrate plaintext secrets in .env* → configured vault",
  "secrets set":
    "Capture a value to the vault: kit secrets set <KEY> --stdin (safer) | --value <v>",
  "secrets rotate": "Rotate a key: write new value to vault (explicit / random)",
  "secrets onecli": "Register a key with OneCLI gateway so agent never sees the real value",
  "secrets purge-history":
    "Destructive: rewrite git history to remove a leaked value (--force-history)",
  "secrets propagate":
    "Push a value to deploy targets only (skips vault-write). --stdin safer than --value",
  "secrets revoke-old": "Revoke a previously-minted scoped key (Supabase Mgmt API)",
  "env switch": "Switch active environment (dev/staging/prod). Gates prod-key reads.",
  "env current": "Show active environment marker",
  "security policy": "Dependency allowlist enforcement (init|add|check)",
  "security clear-cache": "Clear cached scanner binary (after intentional rebuild)",
  "security scan-staged": "Pre-commit: scan staged files for credential patterns",
  "security scan-build": "Scan build artifacts (.next/, dist/) for inlined secrets",
  "security scan-transcripts": "Scan agent transcripts + prompt caches for leaked credentials",
  "security costs": "Snapshot per-key spend vs policy cap (Stripe live; others stubbed)",
  "security check-gitignore": "Verify .gitignore covers sensitive paths (--fix to auto-patch)",
  "security verify-pull": "After git pull: audit new deps, gitignore drops, introduced secrets",
  "security prescan":
    "Multi-repo baseline sweep (secrets, gitignore, branch-protect; --deep adds CVE/workflow-drift/bumblebee; --format=json + --vs-baseline=<path> for CI drift)",
  "security prescan-diff":
    "Diff two prescan reports — surface new regressions + fixed findings since baseline",
  "audit secrets": "Forensics: who/what touched each key + when (reads audit log)",
  "audit verify":
    "Verify the audit log's keyless hash chain + HMAC anchor (--require-external demands a TSA receipt; exit 1 on break/forge/truncation)",
  "audit anchor":
    "Seal the audit log with the machine-local HMAC key (--external also gets a receipt from KIT_EXTERNAL_ANCHOR_CMD — closes the same-UID gap)",
  "audit export": "Emit the audit log for a SIEM (--format cef|syslog|json)",
  "auth elevate":
    "Mint elevation marker for destructive secret ops (TOTP/yes-prompt); --list-scopes to see what each scope unlocks first (--json)",
  "auth status": "Show active elevation",
  "auth revoke": "Drop the elevation marker",
  "auth setup-totp": "Enroll TOTP secret (writes ~/.kit/totp-secret 0600)",
  "hooks add": "Install a built-in hook (secret-scan, post-pull-audit, context-check)",
  "hooks uninstall": "Remove the configured git hooks (enforcement off until re-installed)",
  "setup --recommended":
    "Opinionated profile: setup + memory hooks + git secret-scan/context-check gates",
  "context check":
    "Verify each CLI's live account+project matches .kit.toml [context] (exits non-zero on mismatch)",
  "context use": "Activate the declared context: gcloud config + repo git identity",
  "context --prompt": "Print a compact active-gcloud indicator for your shell prompt (PS1)",
  "config migrate":
    "Migrate .kit.toml to the current schema version (--dry-run inspect, --check CI gate, --force overwrite backup)",
  "config knobs": "List power-user env vars + .kit.toml fields kit honors (--json)",
  version: "Print kit version",
  completions: "Output shell completion script (bash, zsh, fish)",
  help: "Show this help",
  "config recommend":
    "The recommended posture as a report — what this repo would gain, writing nothing",
  "config sections":
    "Every .kit.toml section: what it configures, what declaring it buys, the smallest example, and which ones this repo already declares",
  "monkey-test plan":
    "Detect stack, package manager, Playwright, dev server, seed, local env source, money provider markers, Tauri or Electron desktop shells, harness files, and static security findings",
  "monkey-test init":
    "Create/update the managed Playwright monkey-test harness (playwright.monkey.config.ts, tests/monkey/*, .kit/monkey-test/*) without overwriting unmanaged files unless forced. --install triages and installs a pinned @playwright/test (no install scripts) and downloads Chromium",
  "monkey-test run": "Run the security pack plus desktop/mobile role crawl and sandbox money flow",
  "monkey-test desktop":
    "Drive the real desktop app (Tauri, Electron) through a debug-only eval hook on a temporary data folder: seeded random clicks, and long operations interrupted by close-window, quit, kill, reload, or restart, with data, restart, and lost-work checks after each",
  "skill test":
    "Module-discipline linter for a SKILL.md: contract shape, trigger and sibling collision, declared least-privilege scope, CI regression drift. --runtime audits recorded runs for scope adherence from the transcript index (zero-LLM)",
  "standards freeze": "Snapshot only the standards dimensions into .kit-baseline.json",
  "secrets vault-migrate": "Cross-vault key transfer (1Password → Infisical, etc.)",
  "secrets validate":
    "Verify every declared key resolves in vault. --auto pulls from .env.template",
  "env list": "List configured environments ([env.<name>])",
  "env diff":
    "Drift report between two .env* files (values shown as sha256:8 prefixes — never plaintext)",
  "mcp status": "Alias for kit mcp list",
  "mcp auth": "Show OAuth-flow guidance for vendor",
  "mcp set-token": "Headless / paste-token install",
  "mcp clear": "Remove stored token",
  "mcp web":
    "Interactive ChatGPT-web setup through OpenAI Secure MCP Tunnel; keeps kit private and uses its existing stdio server",
  "hooks install": "Install hooks declared in [hooks]",
  "hooks check": "Report whether the git hooks kit manages are installed and intact",
  "security advisories":
    "Dependency advisories from the repo's own package manager, split into new debt, known debt, and baseline entries that no longer apply. --accept freezes the current set in .kit/advisories.json (and prunes it)",
  "security scan-artifact":
    "Ingestion gate for an untrusted file/tree: byte-level malware scan via the ClamAV delegate. malicious fails and an unverifiable gap fails (no scanner / scan error is never a pass)",
  "upstream check":
    "Latest versions and release notes of the services this project uses (npm + GitHub releases), compared with the installed version: what upgrade is due",
  "triage npm": "Evaluate npm package: registry + GitHub health",
  "triage pip": "PyPI evaluation",
  "triage docker": "Docker image: CVE + sandbox",
  "triage repo": "GitHub repo evaluation",
  "triage skill": "Claude Code / agent skill evaluation",
  "triage all": "Auto-detect + run all checks",
  "triage tools": "List installed security tools",
  "triage check-deps": "Pre-commit gate: fail if staged deps lack triage entries",
  "triage check-skills": "Pre-commit gate: fail if staged skills lack a --deep triage entry",
  "plugin search": "Search plugin marketplace",
  "plugin install": "Install an official plugin",
  "plugin uninstall": "Remove an official package and adapter registration",
  "plugin list": "Show project packages and stale adapter registrations",
  "plugin info": "Plugin metadata",
  "plugin scaffold": "Generate a new plugin skeleton",
  "governance status": "Budget + revocation + agent info",
  "rig plan":
    "Validate rig.toml, print its input id and what to run outside kit for every defect and control",
  "rig ingest":
    "Store a reviewer's findings (JSONL) under the input id; a malformed row is reported by line, --strict refuses the file",
  "rig adjudicate":
    "Decide caught, missed and false positives from file and line alone, write result.json and sign a receipt",
  "rig report":
    "Recall and spread per config for tune and holdout, control false-positive rate, comparisons, and ADR-0007's three limits",
  "rig plant":
    "Turn a past fix into a planted defect: reverse it onto the pinned commit in a throwaway index, write the patch, print the [[defect]] block; refused when the reverse does not apply cleanly",
  "decisions add":
    "Record one choice the run made where the spec was silent. kit never writes the content — that is model work — it provides the form and refuses a malformed entry",
  "decisions list":
    "What this run recorded, plus any line that cannot be read (a ledger that hides its unreadable lines lies by omission)",
  "decisions verify": "The gate's verdict on its own exit code — the same function kit check calls",
  "tools list":
    "Inventory the CLIs on this machine: resolved path, the installer that owns it (measured from the path, never assumed), installed version, and — with --latest — how far behind each one is",
  "memory keygen":
    "X25519 recipient keypair: ephemeral sessions push encrypted with NO secret; only holders of the private key decrypt",
  "memory push":
    "Sync the store to your PRIVATE remote; blobs are always encrypted (passphrase or recipient key)",
  "memory pull":
    "Sync the store from your PRIVATE remote; blobs are always encrypted (passphrase or recipient key)",
  "mcp list": "Show declared MCPs + auth status",
  "memory status": "Alias for kit memory stats",
  "memory learn": "Surface recurring instructions you keep re-typing: candidates for a memory rule",
  "memory verify":
    "Verify the shared tier's signatures (trusted / bad-sig / untrusted / unsigned); exit 1 on a bad signature",
  "memory export": "Render the curated shared tier as an Obsidian vault (--obsidian <dir>)",
  "memory forget-message":
    "Verified-forget one memory row by uuid and prove it is gone (row, FTS index, tombstone)",
};
