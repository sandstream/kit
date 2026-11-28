### Fixed

- **The `unit-test coverage` row no longer passes when it counted zero source files.** A `src/`
  holding only `index.js`, which is excluded by default, read *"every source file has a sibling
  .test file"*. That is true of an empty set and says nothing. When nothing is counted the row is
  now a skip that says what the walk found, for example *"no source files counted: 1 .ts/.js
  file(s) in src, all excluded by name or suffix (src/index.js)"*. A pass now states how many
  files it counted. Found in the kit-research note `audit-year-evidence-vs-kit`.
