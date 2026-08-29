---
name: triage
description: "Security-triage a dependency before installing it."
allowed-tools: Bash
---

# Triage

Deterministic, zero-LLM pre-install security evaluation. kit shells to
`scripts/triage.py` from its watertight install gate; only an explicit
`TRIAGE PASSED` lets an install proceed.

## Run

```
python3 scripts/triage.py <type> <target>
```

| type | target | checks |
| --- | --- | --- |
| `npm` | package name | existence, deprecation, age, maintainer count |
| `pip` | package name | existence, yanked, age, license |
| `repo` | `owner/repo` or a GitHub URL | archived/disabled, maintenance, license, age |
| `docker` | image | existence, freshness, publisher |
| `skill` | path or name | validate a local `SKILL.md` (frontmatter, no secrets), else repo-check |
| `tools` | (none) | list available checks |

## Output contract

- Prints `Health score: N/100`, `Critical issues: N`, `Warnings: N`.
- Prints `TRIAGE PASSED` when there are **zero critical issues**; warnings are
  surfaced and scored but do not, by themselves, withhold a pass (criticals do).
- **Fail-closed:** if a registry cannot be reached (offline, timeout, HTTP error)
  that is a CRITICAL ("cannot verify"), so the pass is withheld and kit blocks the
  install. Set `GITHUB_TOKEN` to avoid GitHub rate limits on `repo` checks.

## Scope

`allowed-tools: Bash` — the whole skill is one subprocess call to
`scripts/triage.py`. It reads no files through the agent (the script opens what it
needs itself), fetches nothing through the agent, and writes nothing. Anything
broader would be a claim this skill cannot cash: an undeclared `allowed-tools`
implicitly claims EVERY tool, which is the opposite of what a gate should assert
about itself.

## Rules

- Stdlib only (urllib). No third-party deps, no network calls other than the
  target registry/API. No LLM, no randomness: same input + same upstream state
  yields the same verdict.
- Keep new checks deterministic and offline-degrading (a check that cannot run is
  a critical, never a silent pass).
