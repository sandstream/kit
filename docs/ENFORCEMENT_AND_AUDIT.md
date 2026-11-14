# What kit is — enforcement *and* audit

> **One line:** kit is a deterministic **meat grinder** that forces a specific, secure way
> of building software through gates — and it also prints a **signed receipt** of what came
> out, while refusing to claim the meat is ground if the grinder wasn't provably on.

Most people meet kit as the grinder (the gates you can't get around) and miss the second half.
kit is two things in one, and they reinforce each other.

## Mode 1 — the grinder: enforcement (real-time, preventive)

Gates that force the process **at the moment an action happens**, before anything can go wrong.
Deterministic, fail-closed, zero-LLM:

- **PreToolUse gates** — `gate-bash`, `gate-env` block un-triaged installs and plaintext-secret
  writes *before* they land.

  `gate-bash` reads the pending command as a shell would, which means it follows installs into
  `$(…)`, backticks, `sh -c '…'`, process substitution and here-strings. **Here-document bodies are
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

This is the "gravitation": you *can't* do X. It shapes **how** software gets built.

## Mode 2 — the receipt: audit (point-in-time + after-the-fact, evidential)

kit also **produces and verifies proof** — of what happened and what's covered:

- **Tamper-evident audit log** — `.kit-audit.jsonl`, HMAC-anchored, hash-chained, Ed25519-signed
  (`verifyAuditChain` / `verifyAuditSignatures`); see `docs/AUDIT_ATTESTATION.md`.
- **`kit self-audit`** — deterministic check of kit's own source against its bug-classes.
- **`kit coverage`** — an OWASP ASVS L2 *evidence map* for GRC (`--json`).
- **`kit sbom`** — component inventory (incl. the agent toolchain, G5); **SARIF** emit feeds
  external audit tooling.
- **verified-forget tombstones** (G1) — deletion you can *prove*; **triage logs** — proof a
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
**machine-local**: everything is tamper-*evident* against someone who can write the log, not
tamper-*resistant* against a same-UID principal who can read a `0600` file. Closing that gap
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

It does not prove that another tool than Claude Code is gated, that the settings file was not edited
after the check, or what the gates allowed and blocked in real sessions (allowed calls are not
logged). On Windows the two pre-commit hook controls are not run, and the row names them.

## The formula

> **kit = a deterministic grinder that forces the secure way of building — and prints a signed
> receipt of what came out, refusing to call it done unless the grinder was provably running.**
