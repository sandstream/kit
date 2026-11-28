### Fixed

- **`kit coverage --verify` no longer marks a repository control verified on a scan that did not
  look at the repository.** NIST 800-53 SA and SR read *verified* when their only backing row was
  `bumblebee (supply-chain)` passing on its default `baseline` profile. That profile reads the
  machine's package roots, and the row's own detail says it does not read this repository's
  dependencies. Such a row now carries `outsideRepository`, and its pass counts as no evidence:
  SA and SR read `unrun` unless another backing check passes. A machine-scope fail still fails the
  control. Found in the kit-research note `audit-year-evidence-vs-kit`.
