# Zero-touch environment fueling

A fresh or ephemeral environment — a cloud dev container, Claude Code on the web,
a CI runner, a new laptop, a teammate's clone — starts **blank**. Re-establishing
tools, secrets, agent gates, identity, and recall by hand every time is the tax
this guide removes: wire two commands into the environment's **setup script** and
every new environment fuels itself.

The whole pattern is:

```sh
kit setup --recommended   # config: tools, secrets (vault-backed), agent gates, verify
kit memory sync <export>  # recall: bring this developer's memory across (optional)
```

Switching environment then never resets your configuration or your memory.

## 1. What each step establishes

| Step     | Command                                  | Establishes                                                                                                                   |
| -------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Config   | `kit setup`                              | tools (mise/aqua per `.kit.toml`), `kit login`, secrets resolved from the vault, agent install-gates, then `kit check` verify |
| Recall   | `kit memory sync` / `kit memory restore` | this developer's conversation memory (private tier)                                                                           |
| Identity | `kit identity init`                      | a per-environment Ed25519 signing identity (or restore an existing one)                                                       |

`.kit.toml` is committed, so the **config contract travels with the repo** — `kit
setup` just realizes it. Secrets are never committed; they are resolved at setup
time from the vault (`kit secrets`), so the environment only needs vault auth, not
plaintext `.env` files.

## 2. `kit setup` is non-interactive-safe

`kit setup` detects a non-interactive context (CI, an agent runner, no TTY) and
runs the **core** setup without prompting — it will never silently wire global
`~/.claude` hooks or git hooks without an explicit yes. Make the choice explicit
in a script:

- `kit setup --recommended` — core + the recommended profile (memory hooks, git
  hooks).
- `kit setup --minimal` — core only.
- `kit setup --mode <name>` — a named preset over the individual knobs (see
  `kit setup --help` for the modes).
- Air-gapped enclave: the network posture is written to `[air_gap]` in `.kit.toml`
  (idempotent); a mode can force it so an enclave setup never reaches for the
  network.

## 3. Where the setup script lives

Put the two commands wherever the environment runs its provisioning hook:

- **Claude Code on the web / remote execution environments** — the environment's
  configured **setup script** (see the environment docs:
  <https://code.claude.com/docs/en/claude-code-on-the-web>).
- **Dev containers** — `postCreateCommand` in `devcontainer.json`.
- **Dockerfile** — a `RUN kit setup --minimal` layer (config only; do memory at
  run time, not build time).
- **CI** — a step before the gates run; pair with `kit check` / `kit ci`.

A minimal, idempotent example (safe to re-run):

```sh
#!/usr/bin/env sh
set -eu

# 1. Config from the committed .kit.toml (non-interactive core + recommended).
kit setup --recommended

# 2. Per-environment signing identity (no-op if one already exists).
kit identity init

# 3. Recall — restore this developer's encrypted memory backup, if provided.
#    KIT_MEMORY_PASSPHRASE comes from the environment's secret store, never inline.
if [ -n "${KIT_MEMORY_BACKUP:-}" ]; then
  kit memory restore "$KIT_MEMORY_BACKUP"
fi
```

## 4. Memory across environments

Recall lives in the **private tier** (`~/.kit/memory.db`, never committed). To
carry it into a new environment today:

- **Encrypted backup → restore**: `kit memory backup <file>` on the source (with
  `KIT_MEMORY_PASSPHRASE`), `kit memory restore <file>` on the target
  (AES-256-GCM with scrypt; the passphrase is never stored).
- **Export → sync**: `kit memory sync <export.db|backup>` last-write-wins on
  sessions; this machine's index state is left untouched.

The **shared / curated tier** (`.kit/shared/memory.jsonl`) is committed, so team
decisions arrive with the clone — no sync step needed. Automatic private-remote
sync (a private git repo / object store, with a guard that the remote is never the
project's own repo) is planned; until then the backup/restore bridge above is the
supported path.

## 5. Guardrails (why this is safe to automate)

- **Secrets never land in plaintext** — `kit setup` resolves them from the vault;
  the environment supplies vault auth, kit supplies the values at use time.
- **Private memory is never committed** — it syncs only via the encrypted
  backup/export bridge above; the committed tier is the curated, secret-scanned
  decisions only.
- **Idempotent + fail-open** — re-running `kit setup` re-realizes the contract
  without clobbering; a missing memory backup just means a blank-but-working
  environment, never a failed setup.
- **Deterministic, zero-LLM** — every step is a deterministic command; nothing
  here calls a model.
