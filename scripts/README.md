# scripts

Portable, harness-agnostic governance scripts. Pure `bash` (`#!/usr/bin/env bash`,
`set -euo pipefail`), no project-specific assumptions. They are **advisory** —
they report PASS/WARN/FAIL and exit non-zero on a finding, but never mutate the
project on their own. Wire them into hooks/CI or run by hand.

## Scripts

| Script | Purpose | Exit |
|---|---|---|
| `dep-add-check.sh` | Gate before adding a dependency: enforce **exact version pin**, **SHA-256 integrity** vs the registry (npm/PyPI/crates.io), and a **triage hook point** (license / maintenance / CVE). Hardens against supply-chain incidents — never install an unpinned range. | 0 pass / 1 needs-attention / 2 usage |
| `skills-hash-verify.sh` | Recompute the SHA-256 of each agent-skill directory and compare to `skills-lock.json`. Flags drift, missing, and unlocked (unreviewed) skills. `update` subcommand re-pins after an intentional change. | 0 match / 1 drift / 2 usage |
| `agent-config-version.sh` | Release command / upgrade path for a synced agent-config bundle: bump the bundle's semver, re-pin every skill hash (delegates to `skills-hash-verify.sh update`), stamp the version into `skills-lock.json`, and promote the `CHANGELOG.md` Unreleased section to a dated release. `--dry-run` previews. | 0 done / 1 refused / 2 usage |

### `dep-add-check.sh`

```bash
dep-add-check.sh npm   left-pad@1.3.0
dep-add-check.sh pip   requests==2.32.3
dep-add-check.sh cargo serde@1.0.210
# Plug in your org triage command (runs as: <cmd> <eco> <name>):
DEP_TRIAGE_CMD="your-org triage" dep-add-check.sh npm express@4.21.0
```

Ecosystem is inferred from the spec (`==` → pip, `@` → npm, or pass `npm|pip|cargo`).
With no triage command configured it prints the manual triage checklist and WARNs
so a human decides.

### `skills-hash-verify.sh`

```bash
skills-hash-verify.sh                # verify against ./skills-lock.json
skills-hash-verify.sh update         # re-pin all skills after an intentional edit
skills-hash-verify.sh --skills-dir ./.agents/skills --lock ./skills-lock.json verify
```

Canonical skill hash = SHA-256 over the sorted `<relpath>\n<sha256(file)>` of
every file in the skill dir (deterministic, follows symlinks). A starter lock
format lives at `templates/skills-lock.json`.

### `agent-config-version.sh`

```bash
agent-config-version.sh minor                      # bump, re-pin hashes, cut release
agent-config-version.sh --set 1.0.0                # release an explicit version
agent-config-version.sh --dry-run patch            # preview without writing
agent-config-version.sh minor --skills-dir ./.agents/skills \
  --lock ./skills-lock.json --changelog ./CHANGELOG.md
```

The upgrade path for an agent-config bundle synced across machines: bumps the
semver, re-pins every skill's content hash (so consumers can detect drift after a
sync), stamps the version into the lock, and promotes the `CHANGELOG.md`
Unreleased notes into a dated release with a fresh stub. Refuses to release an
empty Unreleased section unless `--allow-empty`. Templates:
`templates/{skills-lock.json,CHANGELOG.md}`.

## Requirements

`bash`, `curl`, `python3` (json parsing), and `sha256sum` **or** `shasum`.
`dep-add-check.sh` additionally uses `npm` (node integrity) and `openssl`
(sha512 SRI compare) when present; missing tools degrade to a WARN, not a crash.
