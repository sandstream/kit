### Changed

- **Changelog entries are fragments under `changes/`, not edits to `CHANGELOG.md`.** Every pull
  request used to append to the same `## [Unreleased]` lines, so each merge gave every other open
  branch a CHANGELOG conflict and a full CI rerun; on 2026-11-14 that was more than twenty merges of
  `main` into open branches. A pull request now adds `changes/<name>.md`, and
  `node scripts/changelog-fragments.mjs assemble` merges them at release. A malformed fragment fails
  CI, and the publish job refuses a tag while a fragment is left. Found by kit-research
  `one-person-factory-vs-kit`.
