### Added

- `kit security scan-staged --json` reports the file, line, and pattern for findings and applied exceptions. Kit reads the staged version of the file. The report includes the required reason for each applied `[[scan.allow]]` entry. A file that Kit cannot scan still blocks the commit and appears in the report as a scan gap.
