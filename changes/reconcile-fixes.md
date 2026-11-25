### Fixed

- **The memory `UserPromptSubmit` hook no longer injects its reminder into prompts the user did not
  send.** Claude Code marks a prompt with `source`; in Code Mode, output of background code arrives
  as `source: "poll_event"` and got the same reminder as a typed prompt. The hook now reads the
  payload once (bounded in time and bytes, never from a TTY) and prints nothing for a non-`user`
  source; a payload without `source` keeps the old behaviour. Found by a kit-research reconcile
  (kit-research#223).
- **`scripts/test-weights.json` no longer names a deleted test file, and a test keeps it that way.**
  `src/test-shard.test.ts` now fails when an entry names a test whose source is gone. The timings
  themselves still predate about half of today's test files; only the Windows workflow dispatched
  with `time_files=true` can measure new ones.
- **`kit memory pal` help names session handoff.** The summary and the `kit memory` usage line said
  only "Pending action ledger", while `docs/MEMORY.md` documents handoff (claim, release, takeover)
  through pal.
