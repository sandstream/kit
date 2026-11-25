### Fixed

- **The file-identity check now reads assert calls.** `src/file-identity-discipline.test.ts`
  flagged only `===`/`!==` on `ino`, so `assert.equal(statSync(a).ino, statSync(b).ino)` and its
  `strictEqual`/`notEqual`/`deepEqual` relatives passed it. On Windows a number `ino` is a 64-bit
  NTFS id rounded to a double, so such an equality can pass for two different files. An assert
  comparison that reads `ino` now follows the same rule as `===`: in tests every `ino` comes from
  a `{ bigint: true }` stat, bound by name or read inline. Six assertions in five tests compared
  number ids and now go through `sameIdentity`; the `src/read-only-activation.test.ts` snapshot
  reads bigint stats too.
