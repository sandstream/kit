# Local-first gate: catch everything before code leaves the dev machine

kit's thesis in one line: **the developer's machine is the primary gate, not CI.**
Nothing should first be discovered in GitHub Actions. If a problem can be caught
deterministically, it is caught locally, before the code is ever pushed. CI is a
second, independent environment that confirms the local result and catches the
narrow set of things a local run structurally cannot.

This document states that architecture explicitly so it is a design, not a feeling.

## The two environments have different jobs

**Local (dev machine): the primary gate.**
Runs the full deterministic suite: build, tests, lint, i18n, secret scan, supply
chain, SAST, coverage. Goal: if it is green locally, CI is a formality. Enforced at
the moments code moves:

- **pre-commit** (`kit hooks`): the fast layer (lint, secret scan, conflict markers,
  format). Cheap, runs on every commit.
- **pre-push**: the full gate (`kit check --strict`). Nothing leaves the machine
  without the same checks CI runs having actually run and passed. `--strict` promotes
  a scanner that could not run (not installed, no token, crashed) from WARN to a
  failure, so "green" means "every check actually ran," not "the ones I happened to
  have installed."

**CI (GitHub Actions): the clean-room cross-check and the trust anchor.**
CI is NOT where you first learn something broke. Its job is the set of things local
cannot do:

1. **Clean-room reproducibility.** A fresh checkout on a controlled runner, with no
   local cruft, catches "works on my machine."
2. **A different platform.** Linux on the runner vs the developer's macOS (and the
   native-Windows matrix) surfaces platform-specific breakage.
3. **Independent attestation.** A developer's self-reported local green is not
   trustable by a third party; a CI-produced, signed result (SLSA provenance, the
   check receipt) is. CI is the notary, not the bug finder.

A CI failure should therefore mean "a real environment difference," not "I forgot to
run the check." When CI routinely catches things local did not, the local gate has a
parity gap: close it, do not lean on CI as the safety net.

## Parity is the whole game

The local gate only earns "primary" status if it runs the same checks as CI. The gap
today is tooling and tokens: a scanner that is not installed locally (osv-scanner,
semgrep) or a token that is not wired (Socket, Snyk) makes the local run SKIP a check
that CI runs, so the developer only finds out downstream. That is the drift toward
fire-and-forget.

Closing it:

- `kit setup` provisions the full scanner set locally (mise-managed: semgrep, osv,
  trivy, trufflehog, bumblebee), so the checks actually run rather than skip.
- Vault-backed scanner tokens (`[scan.tooling]` in `.kit.toml`, resolved from your
  vault via the CLI, e.g. Infisical with a machine identity) make token-gated
  scanners run non-interactively, locally and in CI alike.
- `kit doctor` reports the parity gap: which scanner or token is missing to make the
  local gate equal to CI.
- `kit check --strict` then means a missing tool FAILS instead of silently skipping,
  which is what forces parity to be real.

## Why an honest local gate is the prerequisite

A local gate that lies (skips a check but still shows green) is worse than no gate:
you would trust a green that never actually checked. Making every kit operation honest
about skips and failures (no silent no-op, no false green) is the foundation this whole
model rests on. That is why the "no false green" hardening lands first: only an honest
gate can be trusted as the primary one.

## Getting to full local-first (roadmap)

1. Honest gate (done): no operation reports OK while it silently skipped or failed.
2. Provisioned toolchain: `kit setup` installs the full scanner set; `kit doctor`
   surfaces any parity gap against CI.
3. Enforced pre-push: `kit check --strict` on pre-push, once the toolchain is
   provisioned, so nothing leaves the machine unchecked.
4. CI reframed as attestation: CI verifies the same gate ran in a clean room and signs
   the result, rather than being the first place a problem is found.
