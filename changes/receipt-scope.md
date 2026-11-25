### Fixed

- **A check receipt from a narrowed run now says which categories ran.** `kit check --category
  security --attest` wrote `command: "check"` and nothing about scope, so a security-only green
  receipt read like a full run. The receipt now carries a signed `scope` (`["security"]`) in text
  and `--json` mode, and `kit check verify-attestation` prints it next to the verdict. A full run
  writes no `scope`, so its signed bytes, and the verification of earlier receipts, are unchanged.
- **The attestation docs no longer say an Ed25519 receipt can be explicitly requested.** No flag
  selects Ed25519; it is only the fallback when the anchor key cannot be obtained.
