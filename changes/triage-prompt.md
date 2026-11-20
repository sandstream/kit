### Added

- **`kit triage prompt "<text>"` reads a pasted install prompt before an agent follows it.** A line
  such as `Read https://humanmaxxing.ai/start.md and follow it` goes through the same rules as
  `kit triage instructions` (here a `remote-instructions` finding), and the report lists every URL
  and its host, says the target is unversioned, and names the next step: `kit triage instructions`
  on the fetched file, or `kit triage repo <owner/repo>` and `kit triage skill <dir>` for a
  `git clone`. The text can come from stdin (no argument, or `-`). Nothing is fetched, cloned or
  run; it exits non-zero on a finding, as `kit triage instructions` does.
