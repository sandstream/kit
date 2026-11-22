### Fixed

- **An empty audit log is no longer reported as an intact chain.** `kit audit verify` printed
  "audit chain intact, 0 entries" for a log file with no entry, so a log that was emptied read
  the same as a log that verifies. It now reports that the log is empty and that nothing was
  verified, as a separate outcome from a missing log. It fails under `--strict`,
  `require_anchor`, `--require-external` and on a machine that has anchored logs, in the same
  way as a missing log. The JSON report carries `reason: "audit log is empty; nothing verified"`
  and `chain: null`.
- `kit audit verify --all` fails when a sealed log has zero entries.
- `kit audit verify` fails when the audit log exists but cannot be read.
- `kit broker enforce-readiness`, `kit broker enforce`, and `kit doctor` check the audit chain
  and the complete local HMAC seal before they use observe records. Broken, truncated, or
  unsealed evidence gives `unverifiable`. `--gate` fails and `kit broker enforce` requires
  `--force` for that verdict. These checks leave the log and anchor unchanged.
