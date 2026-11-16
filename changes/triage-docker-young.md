### Fixed

- **`kit triage docker` warns on an image repository under 30 days old, whatever its pull count**,
  and says that pull count is reputation, not provenance. A backdoored build of ARTEX reached 8,817
  pulls within a month of its repository's registration (FBI FLASH 2026-11-13); the only publisher
  check was *fewer than 1,000 pulls*, so it passed without a word.
