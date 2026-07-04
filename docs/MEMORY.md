# kit memory

Local-first, deterministic memory for AI agents. `kit memory` gives a (swappable)
model a **verifiable second brain**: it stores your raw conversation history and
lets the agent _search it before answering_ — so it pulls receipts instead of
guessing. No vector database, no embeddings, no model calls. Just SQLite + FTS5
and a few fail-open hooks.

> **Memory is not context.** Context is durable, curated rules (`.kit.toml`,
> policy, `CLAUDE.md`). Memory is the experiential log of what happened. The bridge
> is one-way: memory becomes context only when the agent _retrieves it at the time
> of work_. kit keeps the two as separate shapes with one retrieval pipeline.

## Two tiers, split on the sharing boundary

|               | **Personal memory**                                                           | **Shared project memory**                                        |
| ------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Content       | RAW transcripts, one row per message                                          | curated, **redacted** entries (decisions, conventions, receipts) |
| Scope         | one `~/.kit/memory.db` (all projects); search defaults to the current project | per-project, organized by responsibility-area                    |
| Shared?       | **never** — private, `0600`                                                   | **yes** — committed text, travels with the repo                  |
| Shape (above) | MEMORY (experiential)                                                         | CONTEXT (curated, durable)                                       |

The personal store is yours and never leaves your machine unencrypted. The shared
store is curated knowledge that is **treated like code** — committed, reviewed, and
secret-scanned (see [Shared memory](#shared-memory)).

## Quick start

```bash
npm i -g sandstream-kit
kit memory install          # wire the hooks into ~/.claude/settings.json
kit memory index            # index ~/.claude transcripts into ~/.kit/memory.db
kit memory search "october pricing decision"
```

`install` is idempotent and non-destructive (it merges, preserving your other
hooks). After it runs, the `SessionEnd` hook keeps the store up to date
incrementally — you rarely need to `index` again.

## How it works — a few fail-open hooks, nothing more

The entire system is a handful of Claude Code hooks (all **fail-open**: an error
yields a no-op, so a hook can never block a prompt or break a session):

- **`UserPromptSubmit`** runs before every message and injects a two-sentence
  reminder that searchable memory exists (plus any open action items). The agent
  decides when to search — memory is _pulled on demand_, never bulk-loaded into
  context every turn.
- **`SessionEnd`** indexes the just-ended session into the store.
- **`SessionStart`** (recovery) re-injects "where you left off" for the current
  project — the most recent messages + open action items — so a resumed or
  post-compaction session regains continuity instead of starting blank.

That's it. No reranker, no summarization pipeline, no chunking, no hosted sync
service, no thirty-knob config. Less code, less surface area to break. (Optional
cross-device sync is your own git remote or command — see below, still no service.)

## Why FTS5 and not vectors

`kit memory search` uses SQLite FTS5 full-text search: it returns the row in
milliseconds and the agent reads the **raw text — zero loss, zero guessing**.
Embeddings are lossy, need a model call (which would break kit's deterministic,
zero-LLM core), and most setups never prove keyword search actually failed first.
Keyword search is the default; embeddings remain an explicit, opt-in escalation.

## Personal memory

```bash
kit memory index                      # build/refresh from ~/.claude transcripts
kit memory search <query> [--global]  # FTS5; defaults to the current project, --global = across all
kit memory stats                      # sessions / messages / tool-uses / size
kit memory suggest | <your-llm>       # BYO-LLM review: kit emits a prompt, never calls a model
```

Search is **project-scoped by default** (the git repo you are in) for relevance
and blast-radius containment; `--global` searches every project in your personal
store. The store is a single `~/.kit/memory.db` at mode `0600`.

**Multi-harness.** `kit memory index` is the lead-agent's store but pulls
transcripts from every supported coding agent on the machine, each tagged with a
`harness` so recall spans them: **Claude Code** (`~/.claude`), **Codex**
(`~/.codex/sessions`), **Gemini CLI** (`~/.gemini/tmp`), **Continue.dev**
(`~/.continue/sessions`), **Cursor** (`state.vscdb`), **Amazon Q Developer CLI**
(`amazon-q/data.sqlite3`), **AWS Kiro CLI** (`kiro-cli/data.sqlite3` — same
schema as Amazon Q, `conversations_v2` with a `conversations` fallback), **Cline**
(VS Code `saoudrizwan.claude-dev/tasks`), and **OpenCode**
(`~/.local/share/opencode` — SQLite `opencode.db` or the legacy `storage/` tree).
Absent agents are skipped silently. Adding one
is a single parser in `indexAllHarnesses()`. Each parser is built against the
agent's own serialization format (verified from its source), never guessed. The
Cursor + Amazon Q + Kiro parsers read app-internal SQLite defensively — if the
shape ever differs they index nothing rather than risk wrong data. (GitHub Copilot
CLI, Antigravity IDE, and Zed stay out until their formats are
source-verifiable: see the table in the repo notes.)

### Pending actions (PAL)

A structured "blocked-on-you" ledger on top of the raw log — items that survive
across sessions and **auto-close when their declarative verify check starts
passing**. A verify is a typed, native check (no shell), so it is safe to
auto-run unattended and a planted value can never execute code:

```bash
kit memory pal                                   # list open items
kit memory pal add "ship the release" --verify-http https://example.com --expect 200
kit memory pal add "build artifact exists" --verify-file ./dist/cli.js
kit memory pal done <id> | snooze <id> <days>
kit memory pal verify                            # run checks: N=2 consecutive passes closes; a regression reopens
kit memory pal import                            # migrate a legacy ~/.claude/pal/ledger.jsonl (verifies become manual)
```

Supported verify checks: `--verify-http <url> [--expect <code>]` (kit makes the
request and compares the status) and `--verify-file <path>` (file exists). kit
never runs a shell verify. For a check these types do not cover, run it yourself
and close the item manually. Raw shell `verify_cmd` from pre-1.4 stores is never
auto-executed.

Open items surface in the `UserPromptSubmit` reminder so handed-off tasks stop
getting forgotten. Verify commands run in your shell — they are **operator-authored
and live in the personal store only**; never put an executable verify on an item
that crosses the sharing boundary.

### Named copilots

Bookmark the sessions worth returning to under real names, instead of scrolling a
resume list labelled by whatever you happened to type first.

```bash
kit memory save "stripe-migration"     # bookmark the current session
kit memory threads                     # numbered list of saved copilots (--global for all)
kit memory resume <name|number>        # prints `claude --resume <session-id>`
kit memory forget <name>
```

## Disaster recovery — a stolen laptop

The personal store is local-only, so back it up. `kit memory backup` writes an
**encrypted** blob (AES-256-GCM with a scrypt-derived key from a passphrase that is
**never stored**); put it anywhere — object storage, a USB stick, a private Turso
database.

```bash
# anytime
KIT_MEMORY_PASSPHRASE=… kit memory backup ~/Backups/brain.kitmem

# on a new machine
npm i -g sandstream-kit
KIT_MEMORY_PASSPHRASE=… kit memory restore brain.kitmem
kit setup                              # per repo: reinstall tools + materialize secrets from your vault
```

A wrong passphrase or a tampered blob fails closed (no plaintext is written). Note
that live `claude --resume` is machine-bound — the recovered store gives you back
the searchable _memory_, not the live session. Your **shared** project memory
recovers for free with `git clone`.

## Cross-device sync

Move your personal store between machines automatically — laptop, server, and
ephemeral cloud sessions converging on one hub. Same encrypted-blob mechanism as
backup, wired to a transport. **Opt-in** (no `~/.kit/sync.toml` → nothing happens),
and the remote **only ever sees ciphertext** — the blob is AES-256-GCM encrypted
and **gzip-compressed before encryption** (a SQLite store shrinks ~3×: 139 MB →
~30 MB, so it fits under a git host's 100 MB file limit).

```bash
kit memory push          # encrypt + upload this machine's store to the hub
kit memory pull          # download + merge the hub into this machine (last-write-wins)
```

Config lives at `~/.kit/sync.toml` (LOCAL — never the repo tree, so a cloned repo
can't redirect your brain). The sync remote **must differ from the project's
`origin`** (anti-exfil guard). Two transports:

```toml
# git transport — commit the blob to a SEPARATE private repo (any host, or self-hosted)
[memory.sync]
remote = "https://github.com/you/kit-memory.git"
branch = "main"
pull_on_start = true      # opt-in: hook pulls at session start
push_on_end = true        # opt-in: hook pushes before an (ephemeral) container is reclaimed
```

```toml
# command transport — bring your own move (S3 / rclone / scp / USB …)
[memory.sync]
transport = "command"
push_cmd = 'scp "$KIT_MEMORY_BLOB" you@server:kit-memory.enc'
pull_cmd = 'scp you@server:kit-memory.enc "$KIT_MEMORY_BLOB"'
```

### Two encryption modes

- **Passphrase (default)** — AES-256-GCM + scrypt from `KIT_MEMORY_PASSPHRASE`.
  Simple, but _every_ pushing machine needs the same secret.
- **Public-key (recipient)** — for machines that can't safely hold a secret
  (**ephemeral cloud sessions**: no secret-store, no SSH key). Encrypt to a
  **public** key; only holders of the **private** key decrypt.

```bash
kit memory keygen        # X25519 keypair: private → ~/.kit/memory-key.json (0600),
                         # prints a shareable "kitmem-pub-…" recipient (NOT a secret)
```

```toml
[memory.sync]
remote = "https://github.com/you/kit-memory.git"
recipient = "kitmem-pub-…"   # public — safe in a setup script, env var, or committed
pull_on_start = true
push_on_end = true
```

With a `recipient` set, push needs **no passphrase**. Copy `~/.kit/memory-key.json`
only to the durable machines that must decrypt (laptop, server). Under the hood:
a fresh ephemeral X25519 keypair per blob → ECDH → HKDF-SHA256 → AES-256-GCM
(libsodium sealed-box shape, pure `node:crypto`, zero deps; blob magic `KITMEM03`).

### Seamless ephemeral capture (the payoff)

A throwaway cloud session (Claude Code on the web) can now contribute its memory
to the hub with **nothing secret in the container**: it encrypts to the public
recipient and pushes to a private repo via the environment's injected git
credential — no passphrase, no SSH key, no token to store. Wire it once in the
environment's **setup script** (which re-creates the ephemeral `~/.kit/sync.toml`
at each start) and give that environment access to the hub repo. Your durable
machines pull and decrypt with the private key. `push_on_end` is best-effort
(abrupt teardown can cut it), so the laptop/server stay the reliable backbone.

## Shared memory

Curated knowledge for the team, organized by **responsibility-area** so a growing
system stays navigable: "how did we build WhatsApp, what's next, is it secure?" is
that area's entries — with receipts.

```bash
kit memory share --area stripe --kind decision \
  --title "Connect platform model" --body "why we chose it" --ref "PR #123"
kit memory areas                       # list areas + counts
kit memory area whatsapp               # all entries for an area (decisions, how-built, status, security)
```

Shared memory is **treated like code**:

- **Committed text** — `.kit/shared/memory.jsonl`, one JSON entry per line.
  Diffable, reviewable in a PR, scannable by gitleaks. (Index `kit memory scan`'s
  output too.)
- **Deny-by-default** — nothing is shared automatically; you promote entries with
  `kit memory share`.
- **Allow-listed schema** — only safe fields are persisted (`area`, `kind`,
  `title`, `body`, `refs`, `author`, `ts`, `source_ref`). No raw tool output or
  env dumps can sneak in.
- **Fail-closed secret-scan on write** — if any field contains a secret, the entry
  is refused and nothing is written.
- **Provenance + receipts** — every entry records its git author and source
  commit, and links to the evidence (commit / PR / file). Trust it because it was
  reviewed at merge time, not because the model said so.

> **gitignore:** the shared store is meant to be committed. If your project ignores
> `.kit/`, add `!.kit/shared/` (and keep `.kit/*.db` ignored — those are local
> caches/indexes, never committed).

## Security model

- The personal store is secret-dense (it indexes your real transcripts). It lives
  only under `~/.kit/` at `0600` and is never committed or synced unencrypted.
- `kit memory scan` walks every text cell for secrets (reusing kit's
  `SECRET_PATTERNS`) — gitleaks and most scanners only see text files, not SQLite
  cell contents. It reports masked findings and exits non-zero if any are found,
  so you can use it as a gate.
- Backups are encrypted (AES-256-GCM, scrypt). The passphrase is never stored.
- Shared writes are secret-scanned fail-closed. Verify checks are declarative
  and typed (no shell), and a verify imported or merged from another store is
  demoted to a manual item, so no executable ever crosses a file, DB, or sharing
  boundary and auto-runs.

## Where it sits

`kit memory` is part of kit's deterministic **core** (zero model calls, local-first).
The storage backends are **modules**: SQLite is the default; an encrypted backup
blob is the portable transport, and opt-in cross-device sync (git remote or your
own command — see [Cross-device sync](#cross-device-sync)) and an opt-in embeddings
escalation layer on top without changing the core.

## Credits

The schema and two-hook design are derived from **cloudctx** by chadptk1238
([github.com/chadptk1238/cloudctx](https://github.com/chadptk1238/cloudctx), MIT) —
a Bun-native SQLite memory for Claude Code. kit's implementation is independent
(Node/TypeScript, `node:sqlite`) and adds multi-harness support, project scoping,
a two-tier personal/shared split, secret-scanning, encrypted backup, and PAL. With
thanks for the original idea.
