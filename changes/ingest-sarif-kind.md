### Fixed

- **The SARIF reader honours `result.kind`.** `kit ingest sarif` and `kit scan` reported every SARIF result as a failure, so a scanner's `pass`, `notApplicable` and `informational` rows (Strix writes its coverage rows this way) became findings. Those kinds are now skipped; `fail`, `open` (Nuclei marks every result open), `review` and a result with no `kind` stay findings.
