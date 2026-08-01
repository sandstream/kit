# Performance & Diagnostics Guide

Every command, flag and config section on this page is verified against the
implementation by `kit self-audit` (rule R14, `docs-claims`). A claim that drifts out
of the code fails CI.

This file previously documented a metrics subsystem, eight flags and a `[config]`
section that were never built, with sample output to match. That is why the gate
exists.

## Quick diagnostics

```bash
# Deep environment diagnostics — Node version, tools, config validity
kit doctor

# Current state of tools, services, secrets and lock files
kit status

# The full verdict, every dimension
kit check
```

`kit check --json` emits the machine-readable document; it is the input to
`kit check compare` for a run-to-run diff.

## What actually costs time

kit's check runs its dimensions **sequentially** — tools, services, secrets, skills,
hooks, web search, security scan, lock files, test coverage. There is no parallel
mode and no `--max-parallel`; the cost is the sum of its parts, and the dominant term
is almost always the security scan, because that shells out to external scanners.

Three things that measurably change the wall clock:

1. **Which scanners are installed.** An absent scanner is reported as a gap, not
   silently skipped — so `kit check` on a machine without trivy/trufflehog is *faster*
   and *less complete*. Speed here is not free.
2. **Lock files.** `kit check` verifies `cli-lock.json` / `skills-lock.json` rather
   than re-resolving versions. Keep them committed.
3. **Scope.** `kit check --category security` runs one category instead of all.

## Narrowing a run

```bash
# One category only
kit check --category security

# Machine-readable, for CI or a later diff
kit check --json > after.json

# Compare two runs — ranks coverage loss above regression
kit check compare before.json after.json
```

Real flags on `kit check`: `--json`, `--strict`, `--lenient`, `--fail-on-warning`,
`--fail-on-worse`, `--enforce-tests`, `--pin`, `--key`.

## Per-environment overrides

Environment-specific config lives under `[env.<name>]` in `.kit.toml`:

```toml
# .kit.toml
[env.development]
tools.postgres = "14.0"

[env.production]
# inherits the base config
```

An override is a partial config merged over the base — it can carry `tools`,
`services`, `secrets`, `skills` and `governance`.

## What kit does not provide

Stated explicitly, because their absence was previously documented as presence:

- **No metrics collection.** There is no `metrics` command, no `metrics_enabled` or
  `metrics_file` setting, and no `[config]` section — `[config]` is not a recognised
  section name and `.kit.toml` will report it as unknown.
- **No timing flags.** kit prints no per-step durations and exposes no `--timing`,
  `--save-baseline`, `--compare-baseline`, `--memory-check`, `--stream-output` or
  `--no-cache`.
- **No benchmark or baseline mode for timings.** `kit baseline freeze` exists, but it
  freezes *findings* so future runs gate only on net-new ones. It has nothing to do
  with performance.

## Diagnosing a slow or failing run

```bash
# Is the environment itself sound?
kit doctor

# Which dimension is failing, in full detail
kit check --json

# Did something get worse since the last known-good run?
kit check compare known-good.json now.json
```

`kit check compare` ranks **coverage loss above regression**: a scanner that stopped
running is reported ahead of a check that started failing, because a check that did
not run is not a pass.

## Related

- `docs/ZERO_LLM_CONTRACT.md` — what is on the deterministic verdict path
- `CONTRIBUTING.md` — running the test suite and the self-audit locally
