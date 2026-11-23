### Fixed

- **Semgrep delegates require evidence of scanned files.** Kit checks native file coverage and matches findings against SARIF from the same run. A required scan with no scanned files or incomplete evidence fails the scanner gate.
