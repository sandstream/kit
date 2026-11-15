# Changelog fragments

Do not edit `CHANGELOG.md`'s `## [Unreleased]` section in a pull request. Add one file here
instead, `changes/<short-name>.md`, written exactly as the entry should appear under
`## [Unreleased]`:

```markdown
### Fixed

- **What changed, in one bold sentence.** Why it matters, what a reader should know, and where
  it was found.
```

- The name is lowercase letters, digits and dashes, ending in `.md`. The branch topic is a good
  choice, for example `changes/gate-hook-bypass.md`.
- The headings are Keep a Changelog's: `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`,
  `Security`. One fragment may hold several.
- `src/changelog-fragments.test.ts` validates every fragment here, so a malformed one fails CI.

Two pull requests never edit the same lines this way, so merging one no longer gives every other
open branch a CHANGELOG conflict and a full CI rerun.

At release, `node scripts/changelog-fragments.mjs assemble` merges every fragment into
`## [Unreleased]` and deletes it (see `docs/RELEASING.md`). The publish job refuses a tag while
any fragment is left.
