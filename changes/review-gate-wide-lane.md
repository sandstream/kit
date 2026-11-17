### Added

- **The review gate's wide lane.** A pull request that changes a module 20 or more non-test modules import is no longer approved by the reviewer App on green checks; the owner approves it, as a protected path. The count comes from the default branch's import graph (`src/review-protected-paths-wide.ts`), so a pull request cannot shrink it. 15 modules are wide today, led by `src/config.ts` (120 importers).
