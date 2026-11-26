### Fixed

- **The file-identity check now scans tests too.** `src/file-identity-discipline.test.ts` fails a
  number `ino` comparison, but it skipped `*.test.ts`, so the number comparison in the
  `src/memory/project.test.ts` helper that made Windows CI fail at random (two sibling
  directories with 64-bit NTFS ids rounded to the same double) passed it. A test may still
  compare `ino` directly when every operand was read with `{ bigint: true }` in that file; source
  files must still go through `sameIdentity`.
