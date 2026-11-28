# What kit is — enforcement _and_ audit

> **One line:** kit is a deterministic **meat grinder** that forces a specific, secure way
> of building software through gates — and it also prints a **signed receipt** of what came
> out, while refusing to claim the meat is ground if the grinder wasn't provably on.

Most people meet kit as the grinder (the gates you can't get around) and miss the second half.
kit is two things in one, and they reinforce each other.

## Mode 1 — the grinder: enforcement (real-time, preventive)

Gates that force the process **at the moment an action happens**, before anything can go wrong.
Deterministic, fail-closed, zero-LLM:

- **PreToolUse gates** — `gate-bash`, `gate-env` block un-triaged installs and plaintext-secret
  writes _before_ they land.

  In Claude Code, `gate-bash` is matched to `Bash|PowerShell`: both tools run shell commands, and
  on Windows without Git Bash only `PowerShell` exists. A `Bash`-only matcher, which kit wrote before
  2026-11-27, fails `enforcement gate liveness` in `kit check`; `kit agent-config` widens it in place.
  The opt-in `gate-egress` reads shell commands too (PowerShell's `Invoke-WebRequest` among them)
  and gets the same matcher. Where it is wired, a `Bash`-only entry fails the same row, and
  `kit agent-config --broker-gate` widens it.

  `gate-bash` reads the pending command as a shell would, which means it follows installs into
  `$(…)`, backticks, `sh -c '…'`, the Windows shells (`cmd /c …`, `powershell`/`pwsh -Command …`
  and `-EncodedCommand`), process substitution and here-strings. **Here-document bodies are
  the one place it deliberately stops**: a body is data unless something executes it. Fed to a shell
  (`bash <<EOF`, `cat <<EOF | bash`), or written to a `*.sh`-shaped file, it is scanned as a script;
  otherwise it is text. The exception that keeps this honest: with an UNQUOTED delimiter (`<<EOF`,
  not `<<'EOF'`) the shell performs command substitution while building the document, so `$(…)` in
  the body really runs and is still gated — a quoted delimiter expands nothing, so the identical
  body is inert.

  It also refuses a blanket install-script grant: `npm approve-scripts <pkg> --all` (npm's `--all`
  approves every pending package), `--dangerously-allow-all-scripts`, `--no-ignore-scripts`, and
  `npm config set` or `npm_config_*` turning scripts back on. One package at a time,
  `npm approve-scripts <pkg>`, is triaged like an install.

  `gate-bash` also refuses a command that skips the repository's git hooks: `--no-verify` (or
  `git commit -n`) on a hook-running subcommand, a `core.hooksPath` override or change, `HUSKY=0`,
  and deleting or disabling a hook file. kit's commit checks run in those hooks, and skipping them
  is a person's decision. Reading `core.hooksPath` is allowed.

  It refuses a nested coding agent started with its approvals off, for the same reason: it skips a
  control. Covered, each flag from the vendor's own CLI reference (`src/nested-agent-bypass.ts`):
  `claude --dangerously-skip-permissions` or `--permission-mode bypassPermissions`; `codex
  --dangerously-bypass-approvals-and-sandbox`, `--yolo`, or `-a never` with `-s
  danger-full-access`; `gemini --yolo`, `-y` or `--approval-mode yolo`; `qwen --yolo` or
  `--approval-mode yolo`; Cursor's `agent --force` / `--yolo`; `copilot --allow-all-tools`,
  `--allow-all`, `--yolo` or `COPILOT_ALLOW_ALL`; `kiro-cli --trust-all-tools`; and `droid
  --skip-permissions-unsafe`. It reads through `sh -c`, `env`, `sudo`, `xargs`, `npx` / `npm exec`
  / `pnpm dlx`, `$(…)`, `cmd /c` and PowerShell `-Command` / `-EncodedCommand`, and through the
  herdr launcher: `herdr … --kind <agent> -- <argv>` is read as `<agent> <argv>`, and `herdr … --
  <cmd …>` as `<cmd …>`; herdr commands without `--` start nothing and pass. The refusal names the
  flag and how to run the same agent with approvals on. T3 Code's `t3 thread start`, `t3 thread
  send`, `t3 workflow start` and `t3 workflow resume` are refused whatever their flags: they start
  or steer an agent at the project's default permission mode, which is Full access unless changed,
  and no flag on the command sets it. `t3 thread show`, `list` and the other read-only subcommands
  pass. Not covered: flags no vendor documents
  (Codex `--full-auto`, Amp's `--dangerously-allow-all`, OpenCode, Augment's `auggie`), Cline's
  CLI, which approves everything by default when given a prompt, approval settings in a config
  file or `-c` override rather than on the command line, and launchers that set the mode in their
  own settings (Orca, Paseo, T3 Code).

  It refuses the GitHub actions a scoped token reaches, as it refuses a push to the default branch
  (`src/gh-token-actions.ts`): every `gh pr merge` (plain, `--auto` and `--admin` all land or queue
  a change on the base branch), `gh secret set|delete`, `gh variable set|delete`,
  `gh workflow run|enable|disable`, `gh auth token|refresh|login|switch` and
  `gh auth status --show-token`, a `gh alias set` that expands to one of these, and the same writes
  through `gh api`: a non-GET request (any method spelling: `-X PUT`, `-XPUT`, `--method=put`, or a
  body that makes it a POST) to a pull request's `/merge` or `ccr/auto_merge`, to `/merges`, to a
  `secrets` or `variables` path, to a workflow's `dispatches|enable|disable` or to a repository's
  `dispatches`, and the GraphQL merge mutations. That the token allows an action does not make it
  the agent's decision: the refusal names the action and asks the agent to hand it to the person.
  Reads stay allowed (`gh api` GETs, `gh pr view|list|checks`, `gh run view`, `gh secret list`), and
  so does `gh pr create`. It reads through the same carriers as the nested-agent check
  (`src/gate-bash-carriers.ts`), so `command gh`, `exec gh`, an absolute path, `gh.exe`, a quoted
  `"gh"`, an env prefix, `sh -c`, `$(…)` and PowerShell `-Command` are refused too. It is part of
  `gate-bash`, so every harness whose shell tool kit routes through `gate-bash` is covered (the
  end-to-end test drives the Claude Code and Codex payloads); an agent kit writes only a rules file
  for (Copilot) is not. Not covered: the same request sent with `curl` and a token, a GitHub MCP
  server's merge tool (not a shell command), and a GraphQL query read from a file
  (`-F query=@file`).

  It refuses a system-wide change to the trusted root certificates (`src/ca-trust-store.ts`):
  `update-ca-certificates`, `update-ca-trust`, `trust anchor`, `security add-trusted-cert`,
  `certutil -addstore Root` (or `AuthRoot`), `Import-Certificate` / `Import-PfxCertificate` into
  `Cert:\LocalMachine\Root` or `Cert:\CurrentUser\Root`, and copying, `tee`-ing or redirecting a
  file into an anchor directory (`/usr/local/share/ca-certificates`,
  `/etc/pki/ca-trust/source/anchors` and their Arch and SUSE equivalents). A trusted root lets
  whoever holds its key intercept TLS for every program on the machine. There is no agent-side
  allow, as for a command that cannot be undone: the refusal asks the person to run it. Reading
  the store (`trust list`, `certutil -dump`) is allowed. Out of scope: per-process variables such
  as `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE` and `REQUESTS_CA_BUNDLE`, and NSS databases
  (`certutil -A -d …` on Linux).

  This is a correction, not a design note. Every line of a here-document used to be scanned as its
  own command, and the gate blocked kit's own PR description because the prose contained
  `` `npx tsc --noEmit` `` — a false block, which is what teaches people to reach for `--no-verify`.
  Named limitation: a body written to a file WITHOUT a shell-script extension and executed later is
  not visible to this gate. Neither is the easier spelling of the same bypass — a `Write` tool call,
  which `gate-bash` never sees (`gate-fs` covers writes only where a signed `[scope].fs` exists).

- **Capture-time gates** — the memory write-gate (G1), install-gate, slopsquat scoring (G4).
- **Commit/CI chokepoints** — `kit triage check-deps` + `kit triage check-skills` (pre-commit,
  wired by `kit setup --recommended`), branch-protected checks.
- **`warn → enforce` ramp** — a new gate warns first, then fails once enforced.

This is the "gravitation": you _can't_ do X. It shapes **how** software gets built.

## Mode 2 — the receipt: audit (point-in-time + after-the-fact, evidential)

kit also **produces and verifies proof** — of what happened and what's covered:

- **Tamper-evident audit log** — `.kit-audit.jsonl`, HMAC-anchored, hash-chained, Ed25519-signed
  (`verifyAuditChain` / `verifyAuditSignatures`); see `docs/AUDIT_ATTESTATION.md`.
- **`kit self-audit`** — deterministic check of kit's own source against its bug-classes.
- **`kit coverage`** — an OWASP ASVS L2 _evidence map_ for GRC (`--json`).
- **`kit sbom`** — component inventory (incl. the agent toolchain, G5); **SARIF** emit feeds
  external audit tooling.
- **verified-forget tombstones** (G1) — deletion you can _prove_; **triage logs** — proof a
  dependency was evaluated.
- **`kit check` / `check-security`** — point-in-time repo audit.
- **`docs/STANDARDS.md`** — an honest map of which standards kit aligns to (and which it doesn't).

This is the "label + receipt": proof of **what** was produced, and to which standard.

## The loop — why they're one tool, not two

The two modes are wired together, and that wiring is kit's thesis:

1. **The grinder produces the evidence** — every gate decision can be logged and attested.
2. **The audit proves the grinder was on** — gate-liveness and hook-liveness checks, and
   self-audit rule **R13 (catch-false-green)**, fail if enforcement isn't actually installed.

That closed loop is **"no false green"**: kit will not report a clean result it cannot prove.
An audit tool that can't confirm its own controls are live is just theater; kit's audit side
exists partly to keep its enforcement side honest.

## An honest boundary (same no-false-green spirit)

As an audit tool kit is strong on **integrity evidence**, but its trust anchor is
**machine-local**: everything is tamper-_evident_ against someone who can write the log, not
tamper-_resistant_ against a same-UID principal who can read a `0600` file. Closing that gap
means a non-exportable signing key. kit supports one today through an external signer:
`KIT_KEYSTORE=command` with `KIT_KEYSTORE_SIGN_CMD` and `KIT_KEYSTORE_PUBKEY`, for a TPM,
HSM, enclave or YubiKey you drive yourself; `kit identity keystore` reports which backend
is active. The native TPM and Secure Enclave stores are stubs that report unavailable.
Without an external signer, kit is
excellent proof of what **you** did under enforcement — not forensic proof against an attacker
who already owns your user account.

## Evidence that the gates work, not only that they are wired

`enforcement gate liveness` answers whether the PreToolUse gates are in the settings. That is a
belief about a file. The `enforcement evidence` row of `kit check` adds what kit can show:

- **wired**: the install gate and the env-write gate are configured.
- **refuses**: the negative controls of `kit usage prove` held just now. They run on every check
  (about two seconds) against kit's own gate code, in throwaway directories. An install kit cannot
  verify is refused, a harmless command is allowed, a plaintext credential written to `.env` is
  refused, a harmless write is allowed, and kit's pre-commit hook refuses a staged credential and
  lets a clean commit through. Nothing is stored between runs: a stored result would be a claim in a
  file that the checked agent can write.
- **bypassed**: no commit skipped the pre-commit hook in the last 14 days (the same count as the
  banner).

A control that ran and did not hold is a failure. A control that could not run is unverified. A
skipped hook is a warning. The row never runs the commands a settings file names, because that file
is repository content.

It does not prove that the wired commands run kit's gate (the controls run this kit's own build; a
settings entry that points at any executable that exits 0 passes both rows), that another tool than
Claude Code is gated, that the settings file was not edited after the check, or what the gates allowed and blocked in real sessions (allowed calls are not
logged). On Windows the two pre-commit hook controls are not run, and the row names them.

Kit's own GitHub CI also lists pull request commits without a matching local hook marker.
After the local pre-commit checks pass, the commit hook adds a `Kit-Hook-Tree` trailer.
CI compares the trailer with the committed tree and warns with the affected commit IDs.
The trailer is advisory. A contributor can construct it, and commits from other tools
can lack it. The required CI gates still judge the change.

## kit's deny rules, still where it wrote them

`kit agent-config` writes twelve Claude Code deny rules into the project `.claude/settings.json`:
the credential directories (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gcloud`), `.env` and
`.env.*` with `.env.example` carved back out, the four force-push forms and `git reset --hard`.
`kit agent-config --user` writes gate hooks only, no deny rule.

The `deny rule liveness` row of `kit check` reads them back:

- It applies where `kit agent-config` wrote the deny rules (its marker
  `.claude/.kit-deny-rules-installed`, or any kit deny rule in `.claude/settings.json`). It skips
  elsewhere: a fresh clone, CI, or a checkout whose gates came from `kit setup` or `kit hooks gates`,
  which write no deny rule.
- It fails when any of the twelve is missing from `.claude/settings.json`, or when that file does
  not parse. The detail names each missing rule. `kit agent-config` appends the missing ones and
  keeps the rest.
- Claude Code applies deny rules before allow rules, in every scope. An allow rule in
  `.claude/settings.local.json` (the file a "don't ask again" answer writes) that matches one of
  kit's deny rules does nothing while that deny rule is there. The row names such an allow in the
  failure when its deny rule is missing, and in the passing detail otherwise.

"Matches" is decided on one concrete call per deny rule (`git push origin main --force`,
`~/.ssh/id_ed25519`): an allow of the same tool that would let that call through matches. The row
does not read user-scope or managed settings, and it does not cover Codex, Cursor, Gemini or other
harnesses' rule files, where kit writes no deny rule.

## Claude Code's sandbox network

`kit agent-config` turns on Claude Code's sandbox (`sandbox.enabled`) in the project
`.claude/settings.json`. That alone does not close the network. Claude Code decides a host outside
`sandbox.network.allowedDomains` by permission mode: it asks by default, and in `bypassPermissions`
mode it allows the host without a prompt. Only `sandbox.network.strictAllowlist: true` (user or
managed settings, Claude Code v2.1.219 or later) or the managed `allowManagedDomainsOnly` makes it
refuse every such host. A repository file cannot set `strictAllowlist`, so kit does not write it.

The `Claude Code sandbox network` row reports this in `kit check` and `kit agent-audit`, and
`kit agent-config` prints the same line after it turns the sandbox on:

- It warns when the sandbox is on and neither key is set where Claude Code honors it. The warning is
  medium when a settings file sets `permissions.defaultMode: "bypassPermissions"`, and low
  otherwise.
- It passes when the user (`~/.claude/settings.json` or `$CLAUDE_CONFIG_DIR`) or managed settings
  (`managed-settings.json` and `managed-settings.d/`) make the allowlist strict.
- It skips when the sandbox is off and on native Windows, where the sandbox does not run.

It does not read server-managed or MDM settings or `--settings`, and it does not judge a custom proxy
(`httpProxyPort`, `socksProxyPort`), which takes over the filtering. It covers Claude Code only. Codex
network access is not covered.

## Verify a Vercel token

Run `kit check verify-vercel-token` when `VERCEL_TOKEN` is declared
with `source = "env"`. Kit sends the token only to [Vercel's user endpoint](https://vercel.com/docs/rest-api/user/get-the-user).
It follows no redirect and prints neither the token nor the response body.
The JSON check uses `secretState` for a missing, unreadable, or rejected token.
Air-gap mode and network errors report an unverified check. The ordinary
`kit check --category secrets` reports whether the environment value is present.

## The formula

> **kit = a deterministic grinder that forces the secure way of building — and prints a signed
> receipt of what came out, refusing to call it done unless the grinder was provably running.**
