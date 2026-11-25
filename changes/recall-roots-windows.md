### Fixed

- **The memory recall-roots test no longer fails at random on Windows.** Its "same directory"
  helper fell back to comparing `statSync().ino` as a number. On Windows that is a 64-bit NTFS
  file id rounded to a double, so two sibling directories created a moment apart could compare
  equal, and the test reported an unrelated directory as a recall root although
  `getProjectRecallRoots` never returned it. The helper now uses the bigint `sameIdentity` from
  `src/utils/same-file.ts`; the code under test was correct and is unchanged.
