### Fixed

- **The SARIF reader honours `result.suppressions` and reads `kind: review` as a warning.** `kit ingest sarif` and `kit scan` reported a suppressed SARIF result as a failure. A result whose suppressions are all `accepted` (or have no `status`, which SARIF defines as accepted) is now left out of the findings and counted as `suppressed` in `kit ingest --json`; an `underReview` or `rejected` suppression keeps it a finding. A `review` result (a person must still look) is now a warning, not a failure.
