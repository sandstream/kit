### Added

- `kit check` reports whether the default branch's required status checks are pinned to the app that reports them (row "default branch required check sources", GitHub, with the token kit already uses for branch protection). A required check that names no source accepts a same-named check from any token that can write commit statuses; the row warns and names those checks. Rulesets are read with read access; classic protection needs admin and is reported as not read.
