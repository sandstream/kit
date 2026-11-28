### Fixed

- **GuardDog now verifies an npm package whose archive root folder it cannot read.** GuardDog 3.2
  reads `package.json` only from `package/` or a folder named after the package, so its
  `metadata_mismatch` rule failed on `@types/node` 22.x, whose tarball root is `node v22.20/`, and
  the nightly GuardDog sweep stayed "Coverage unverified". Kit now reruns that one rule on the
  archive's `package.json` under `package/`, after checking the tarball against the registry's
  integrity. A rerun that cannot complete leaves the package unverified, and a mismatch it finds
  counts as a malware indicator.
