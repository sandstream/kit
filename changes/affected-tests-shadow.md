### Added

- **CI reports which tests a change affects, in shadow mode.** `scripts/affected-tests.mjs` builds
  the import graph of the TypeScript sources and lists the test files that a pull request's changed
  files reach. It answers "run everything" for a change it cannot place: a file outside the source
  directories that is not a document, a shared test helper, a file with more than 40 transitive
  importers, a deleted file, or a selection over 200 test files. The `build-and-test` job still
  runs every test. Two new steps write to the job summary what the selection would have run and,
  for each test file that failed, whether the selection contained it. Neither step can fail the
  job. See "kit's own CI: affected tests" in `docs/CI_AND_GIT_HOSTS.md`.
