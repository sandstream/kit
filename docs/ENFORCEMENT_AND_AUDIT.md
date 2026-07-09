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
- **Capture-time gates** — the memory write-gate (G1), install-gate, slopsquat scoring (G4).
- **Commit/CI chokepoints** — `kit triage check-deps` (pre-commit), branch-protected checks.
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
tamper-*resistant* against a same-UID principal who can read a `0600` file. Closing that gap is
the point of hardware-rooted identity (TPM/HSM) on the kit 5.0 roadmap. Until then: kit is
excellent proof of what **you** did under enforcement — not forensic proof against an attacker
who already owns your user account.

## The formula

> **kit = a deterministic grinder that forces the secure way of building — and prints a signed
> receipt of what came out, refusing to call it done unless the grinder was provably running.**
