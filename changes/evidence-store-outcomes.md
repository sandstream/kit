### Fixed

- **An empty audit log is no longer reported as an intact chain.** `kit audit verify` printed
  "audit chain intact, 0 entries" for a log file with no entry, so a log that was emptied read
  the same as a log that verifies. It now reports that the log is empty and that nothing was
  verified, as a separate outcome from a missing log. It fails under `--strict`,
  `require_anchor`, `--require-external` and on a machine that has anchored logs, in the same
  way as a missing log. The JSON report carries `reason: "audit log is empty; nothing verified"`
  and `chain: null`.
- **`kit broker enforce-readiness` no longer gives a verdict from a log with a broken chain.**
  The command, `kit broker enforce` and the `exec-broker runtime` row of `kit doctor` counted
  the observe events without verifying the hash chain, and skipped lines that did not parse.
  Removing one would-be denial from the log turned `would-block` into `ready`, and
  `kit broker enforce` then made the flip. A broken chain now gives the new verdict
  `unverifiable` with the entry and the reason, `--gate` fails on it, and `kit broker enforce`
  refuses it without `--force`. Limit: the hash chain does not show a log that lost its last
  lines; `kit audit verify` finds that with the anchor.
