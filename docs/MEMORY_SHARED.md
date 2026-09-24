# Shared memory

Curated knowledge for the team is organized by **responsibility-area** so a growing
system stays navigable: "how did we build WhatsApp, what's next, is it secure?" is
that area's entries — with receipts.

```bash
kit memory share --area stripe --kind decision \
  --title "Connect platform model" --body "why we chose it" --ref "PR #123"
kit memory areas                       # list areas + counts
kit memory area whatsapp               # all entries for an area
```

Shared memory is **treated like code**:

- **Committed text** — `.kit/shared/memory.jsonl`, one JSON entry per line.
  Diffable, reviewable in a PR, scannable by gitleaks. Index `kit memory scan`'s
  output too.
- **Deny-by-default** — nothing is shared automatically; promote entries with
  `kit memory share`.
- **Allow-listed schema** — only safe fields are persisted (`area`, `kind`,
  `title`, `body`, `refs`, `author`, `ts`, `source_ref`). Raw tool output and env
  dumps cannot sneak in.
- **Fail-closed secret scan on write** — if any field contains a secret, entry is
  refused and nothing is written.
- **Provenance + receipts** — every entry records its Git author and source commit,
  and links to evidence (commit, PR or file). Trust comes from merge review, not a
  model assertion.

The shared store is meant to be committed. If project ignores `.kit/`, add
`!.kit/shared/`; keep `.kit/*.db` ignored because those are local caches and indexes.

For private transcript storage, encrypted transport and recall, see
[kit memory](MEMORY.md).
