### Fixed

- **`kit triage skill` no longer reports the word after a Markdown link to a URL as a missing
  bundled file.** The URL strip matched up to the next whitespace, so it also removed the `)`
  closing the link, and the link rule then read the following word as the link's target:
  `See [the docs](https://example.com/docs) before you start.` gave "SKILL.md names before, which
  is not there" (kit-research `auto-ontology-vs-kit`; it cost a real skill 12 points). Links are now
  read before URLs are removed, a target with a scheme is never a file, and a URL ends at `)`, `>`
  or whitespace. A relative link to a missing file is still reported.
