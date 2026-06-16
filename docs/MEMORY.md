# kit memory

Local-first, deterministic memory for AI agents. `kit memory` gives a (swappable)
model a **verifiable second brain**: it stores your raw conversation history and
lets the agent *search it before answering* — so it pulls receipts instead of
guessing. No vector database, no embeddings, no model calls. Just SQLite + FTS5
and a few fail-open hooks.

> **Memory is not context.** Context is durable, curated rules (`.kit.toml`,
> policy, `CLAUDE.md`). Memory is the experiential log of what happened. The bridge
> is one-way: memory becomes context only when the agent *retrieves it at the time
> of work*. kit keeps the two as separate shapes with one retrieval pipeline.

## Two tiers, split on the sharing boundary

| | **Personal memory** | **Shared project memory** |
|---|---|---|
| Content | RAW transcripts, one row per message | curated, **redacted** entries (decisions, conventions, receipts) |
| Scope | one `~/.kit/memory.db` (all projects); search defaults to the current project | per-project, organized by responsibility-area |
| Shared? | **never** — private, `0600` | **yes** — committed text, travels with the repo |
| Shape (above) | MEMORY (experiential) | CONTEXT (curated, durable) |

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
  decides when to search — memory is *pulled on demand*, never bulk-loaded into
  context every turn.
- **`SessionEnd`** indexes the just-ended session into the store.
- **`SessionStart`** (recovery) re-injects "where you left off" for the current
  project — the most recent messages + open action items — so a resumed or
  post-compaction session regains continuity instead of starting blank.

That's it. No reranker, no summarization pipeline, no chunking, no sync service,
no thirty-knob config. Less code, less surface area to break.

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
(`~/.continue/sessions`), and **Cursor** (`state.vscdb`). Absent agents are
skipped silently. Adding one is a single parser in `indexAllHarnesses()`. Each
parser is built against the agent's own serialization format (verified from its
source), never guessed. Cursor's store is app-internal + reverse-engineered, so
its parser is deliberately defensive — if the shape ever differs it indexes
nothing rather than risk wrong data. (GitHub Copilot CLI stays out until its
`events.jsonl` has a documented schema/stability contract.)

### Pending actions (PAL)

A structured "blocked-on-you" ledger on top of the raw log — items that survive
across sessions and **auto-close when their verify command starts passing**.

```bash
kit memory pal                                  # list open items
kit memory pal add "ship the release" --verify "curl -fsS https://… | grep -q 200"
kit memory pal done <id> | snooze <id> <days>
kit memory pal verify                            # run verifies: N=2 consecutive passes closes; a regression reopens
kit memory pal import                            # migrate a legacy ~/.claude/pal/ledger.jsonl
```

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
the searchable *memory*, not the live session. Your **shared** project memory
recovers for free with `git clone`.

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
- Shared writes are secret-scanned fail-closed; executable verify commands never
  cross the sharing boundary.

## Where it sits

`kit memory` is part of kit's deterministic **core** (zero model calls, local-first).
The storage backends are **modules**: SQLite is the default; an encrypted backup
blob is the portable transport, and an opt-in Turso live-sync (and an opt-in
embeddings escalation) layer on top without changing the core.

## Credits

The schema and two-hook design are derived from **cloudctx** by chadptk1238
([github.com/chadptk1238/cloudctx](https://github.com/chadptk1238/cloudctx), MIT) —
a Bun-native SQLite memory for Claude Code. kit's implementation is independent
(Node/TypeScript, `node:sqlite`) and adds multi-harness support, project scoping,
a two-tier personal/shared split, secret-scanning, encrypted backup, and PAL. With
thanks for the original idea.
