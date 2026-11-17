### Added

- **A cap on test growth: a change that adds more than 400 net new test lines needs a stated
  reason.** `scripts/test-growth.mjs` sums the net added lines in `src/**/*.test.ts` and
  `*.test-support.ts` from `git diff --numstat origin/main...HEAD`. Over 400 it fails, unless a
  commit on the branch carries a `Test-Growth: <reason>` trailer, which it prints. It runs as a step
  of `scripts/prepush.mjs` and as the `test-growth` job in `.github/workflows/pr-hygiene.yml`. None
  of the last 20 changes merged to main would have tripped it (the largest added 324).
