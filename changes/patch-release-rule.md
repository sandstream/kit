### Changed

- **A patch release is bug fixes only, and the release path now holds it.** `CHANGELOG.md` has always
  said "PATCH — Bug fixes", yet 10 of 37 patch sections had `### Added` (the latest 7.2.2, a new
  command). `node scripts/changelog-fragments.mjs assemble` refuses to put an `### Added` entry
  under `[Unreleased]` while `package.json` names a patch version, and `check --none-left`, which
  the publish job runs before `npm publish`, refuses a patch version whose `## [X.Y.Z]` section has
  `### Added`. Only the version being released is checked; published sections keep their history.

### Added

- **The release prep names the fixes that rewrite a fix.** `assemble` prints, from git alone, the
  fix commits since the previous `v*` tag that change lines another fix in the same range wrote
  (`node scripts/fix-of-fix.mjs [<range>]` prints the same line). In 7.5.0..7.6.0 that was 8 of 39,
  one of them a regression the earlier fix introduced. It is informational and never fails.
