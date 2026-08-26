# Claude memory vs kit memory

Date: 2026-08-26

Scope: research note. This compares Anthropic's current Claude memory system
with kit memory using official Anthropic sources and local kit source/docs.

## Short answer

Claude's new memory is a product feature: it turns prior chat/Cowork context
into user-visible topics, exposes read/edit/delete controls, shares memory
between Chat and cloud Cowork, and gives users/org owners toggles for memory and
sensitive topics.

kit memory is a local control-plane feature: it stores raw agent transcripts in
SQLite, retrieves them with deterministic FTS5 search, restores project
continuity through lifecycle hooks, and promotes only curated team knowledge into
a committed `.kit/shared/memory.jsonl` file. It does not try to be a hosted user
profile, SaaS admin dashboard, or model-generated topic memory system.

## Anthropic current product facts

Official sources read:

- Anthropic Help Center:
  [Use Claude's chat search and memory to build on previous context](https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context)
  (updated 2026-08-26 when read).
- Anthropic product blog:
  [Claude's memory works everywhere, and you decide what's in it](https://claude.com/blog/claudes-memory-works-everywhere-and-you-decide-whats-in-it)
  (2026-08-25).
- Anthropic Help Center:
  [Claude Cowork architecture overview](https://support.claude.com/en/articles/14479288-claude-cowork-architecture-overview).
- Anthropic Help Center:
  [Get started with Claude Cowork](https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork?vid=527)
  (updated 2026-08-26 when read).

Findings:

- Chat search is available on paid Claude plans and uses RAG-style tool calls
  over prior conversations. Users can turn chat search off, and incognito chats
  are excluded from search. Enterprise/Team users with customer-managed
  encryption keys cannot use past-chat search because conversation content is
  encrypted.
- Claude memory is on by default for Free, Pro, and Max plans across web,
  Desktop, and Mobile. Team and Enterprise memory is off by default and must be
  enabled by an owner before users can turn it on.
- Claude memory is shared between Chat and Claude Cowork only when Cowork runs
  in the cloud. Local Cowork sessions on the user's computer do not use this
  shared memory.
- Claude stores memory as individual topics while users chat, not as an
  end-of-conversation summary batch. Users can explicitly ask Claude to remember
  something.
- Projects have separate memory spaces and project summaries.
- Users can view saved memories under Topics in Memory settings, read each
  topic, edit it, delete it, and update memory through chat. Changes apply to
  later conversations.
- Users can pause memory or reset it. Reset deletes memories, including project
  memories, and is irreversible from the UI flow described by Anthropic.
- Sensitive topics are off by default. Claude normally avoids saving sensitive
  personal topics such as health, race, ethnicity, religion, politics, and
  gender identity. Users can opt into "Include sensitive topics in memory".
  Claude says some categories are never saved even if requested, including
  government ID numbers, criminal history, financial account numbers, and
  immigration status.
- Team/Enterprise owners can enable or disable memory and sensitive-topic
  availability at org level. Owners cannot view or edit individual user
  memories, but org-level disable deletes all memory data for the organization.
  Anthropic also says memory is unavailable for organizations with HIPAA,
  public-sector, or custom data-retention agreements.
- Cloud Cowork runs agent loop and code execution on Anthropic-managed
  infrastructure in isolated temporary sandboxes; local file access goes through
  Claude Desktop permissions when needed. Local Cowork remains a separate
  device-side execution mode.

## Local kit evidence

- kit's documented memory model is "local-first, deterministic": raw
  conversation history is searched before answering; docs explicitly say no
  vector database, no embeddings, and no model calls
  (`docs/MEMORY.md:3-7`).
- Personal memory and shared project memory are intentionally separate. Personal
  memory is raw transcript history in one private store; shared memory is
  curated, redacted context that travels with the repo
  (`docs/MEMORY.md:14-25`).
- The personal store is a single `~/.kit/memory.db`, search defaults to the
  current project, and `--global` widens recall
  (`docs/MEMORY.md:73-82`).
- The database source says memory is raw and append-only: one row per message,
  no summarization, retrieval at time of work, and 0600 local storage
  (`src/memory/db.ts:1-13`).
- FTS5 is literal schema, not a product claim: `messages_fts` indexes message
  content and insert/delete/update triggers keep it current
  (`src/memory/db.ts:169-184`).
- `searchMessages` builds safe FTS5 MATCH queries, filters quarantined rows by
  default, can scope to one project path, and ranks by FTS5 bm25; optional
  recency boost uses deterministic RRF, still zero-LLM
  (`src/memory/db.ts:634-717`).
- The zero-LLM contract is separately documented and mechanically enforced:
  kit security verdicts and gate decisions must be deterministic, LLM SDK
  imports are banned, and dependency tests guard against declared model SDKs
  (`docs/ZERO_LLM_CONTRACT.md:1-8`,
  `docs/ZERO_LLM_CONTRACT.md:45-62`, `eslint.config.js:103-137`,
  `src/zero-llm-boundary.test.ts:7-13`,
  `src/zero-llm-boundary.test.ts:53-75`).
- Claude Code hooks are `UserPromptSubmit`, `SessionEnd`, and `SessionStart`;
  Codex hooks are `SessionEnd` and `SessionStart`, with old Codex
  `UserPromptSubmit` wiring retired because stdout is noisy in the UI
  (`src/memory/install.ts:57-87`).
- `UserPromptSubmit` reminds the agent that local memory exists and reports open
  PAL items, but it fails open and does not force a search
  (`src/memory/hook.ts:59-89`).
- `SessionStart` recovers recent project messages, PAL items, and curated
  shared decisions; it labels recalled content as stored data, not instructions
  (`src/memory/hook.ts:178-256`).
- `SessionEnd` starts a detached capture worker and falls back to inline capture
  if spawning fails, so hook timeouts do not silently drop the ended transcript
  (`src/memory/hook.ts:385-415`).
- Codex gets statusline context through `SessionStart`, while Claude Code can use
  visible `statusLine`; statusline assembly is cheap, read-only, and has no
  network hot path (`src/commands/memory.ts:1035-1050`,
  `src/statusline.ts:1-12`).
- Shared memory is committed text at `.kit/shared/memory.jsonl`, diffable,
  PR-reviewable, gitleaks-scannable, deny-by-default, allow-listed by schema,
  fail-closed on secrets, and provenance-bearing
  (`docs/MEMORY.md:239-270`, `src/memory/shared.ts:1-16`).
- Shared entries support lifecycle/provenance fields plus Ed25519 signer ids and
  signatures (`src/memory/shared.ts:57-88`).
- Shared-tier verification checks signatures against policy-anchored org keys
  when present, or local identity keys otherwise (`src/memory/shared.ts:194-217`).
- Auto-injected shared entries are filtered through `recallSafeShared`, which
  drops tampered entries and can require org-trusted signatures when a committed
  signer anchor exists (`src/memory/shared.ts:219-235`).
- Capture-time write-gate rejects invalid schema in all modes, quarantines or
  rejects injection/oversize/secret-bearing rows, and is pure/deterministic
  (`src/memory/write-gate.ts:1-25`, `src/memory/write-gate.ts:63-123`).
- Insert path runs the write-gate before persistence; unexpected gate errors
  fail closed toward prompt recall by quarantining in warn mode or rejecting in
  enforce mode (`src/memory/db.ts:402-422`).
- Recall excludes quarantined prompt-injection rows by default; the CLI only
  shows them with `--include-quarantined`
  (`src/memory/db.ts:590-602`, `src/commands/memory.ts:862-900`).
- Prompt replay has a deterministic sanitizer chokepoint: store-derived text is
  stripped of hidden characters and high-confidence injection phrases are
  flagged before replay/render (`src/memory/injection.ts:321-335`).
- `kit memory scan` scans SQLite text cells directly, masks findings, attributes
  them to projects, and fails only on high-confidence findings
  (`src/memory/scan.ts:1-14`, `src/commands/memory.ts:1530-1565`).
- Sensitivity classes exist as pure policy (`public`, `internal`,
  `restricted`) and fail closed for invalid/unrecognized values
  (`src/memory/class.ts:1-24`, `src/memory/class.ts:26-105`).
- The README explicitly warns that classified memory is only partially wired:
  rows carry a class and disclosure logic exists, but call sites do not yet pass
  per-project class or recall context, so the override is not reliable as a
  product-grade sensitive-topic control (`README.md:281-282`).
- kit's threat model says there is no central server, no SaaS dashboard, no
  default telemetry, and no background process; the CLI is the product
  (`docs/THREAT_MODEL.md:60-73`).
- Optional personal-memory sync is user-owned, opt-in, separate from the project
  repo, encrypted before it reaches the remote, and still deterministic
  (`src/memory/remote-sync.ts:1-20`).

## Comparison

| Axis                   | Claude memory                                                                      | kit memory                                                                                                 |
| ---------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Primary user           | End user/team using Claude app and cloud Cowork                                    | Local developer/agent workflow in a repo                                                                   |
| Storage shape          | Product-managed memory topics plus project memory                                  | Raw transcript rows in SQLite plus curated repo JSONL                                                      |
| Retrieval              | Product RAG/chat search plus automatic memory topics                               | Explicit `kit memory search`, SessionStart recovery, shared decision injection                             |
| Visibility             | Settings UI lists Topics; user can read/edit/delete                                | CLI search/stats/forget/share/verify; shared tier is git-reviewable text                                   |
| Cross-surface behavior | Same memory across Chat and cloud Cowork; not local Cowork                         | Cross-harness local transcript index; shared entries travel with repo; optional private sync is user-owned |
| Governance             | User toggles; owner controls for Team/Enterprise availability and sensitive topics | Git review, secret scans, write-gate, quarantines, signatures, policy anchors                              |
| Sensitive topics       | First-class product control with default exclusion and user/org settings           | Low-level class policy exists, but product-level sensitive-topic UX/admin controls do not                  |
| Trust model            | Anthropic-managed service, retention/export/admin policy                           | Local deterministic store plus committed, reviewable, signed shared context                                |
| Main limitation        | Opaque product internals; cloud memory only where Anthropic enables it             | No SaaS UI, no org topic editor, local/repo-scoped by design, class filtering still partial                |

## Implications for kit

1. Do not describe kit as equivalent to Claude memory. The strongest positioning
   is "verifiable local recall and reviewable team context for agents", not
   "Claude-style user memory".
2. Keep the local/shared split explicit. Claude's value is seamless product
   continuity; kit's value is receipts, git review, deterministic search, and
   no model in the recall path.
3. Be precise about sensitivity. kit has real primitives: write-gate,
   quarantine, secret scan, shared-tier allow-listing, and class policy. It does
   not yet have Claude-like sensitive-topic UI, org admin controls, or fully
   wired per-project disclosure classes.
4. Product inspiration worth considering: a topic-like curated memory view could
   improve operator ergonomics, but it should remain backed by reviewable files
   or explicit CLI commands rather than hidden model state.
5. The right comparison line for docs: Claude memory optimizes user convenience
   across Anthropic surfaces; kit memory optimizes agent accountability across
   local tools, repos, and CI gates.

## Bottom line

Claude's memory is broader and more user-facing. kit memory is narrower and more
auditable. They solve adjacent problems: Claude reduces re-explaining inside
Claude products; kit makes agent recall portable, deterministic, reviewable, and
safe enough to use in a public repo workflow.
