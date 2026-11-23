### Fixed

- `kit triage skill <path> --deep` requires complete static coverage from SkillSpector. It fails when the scan is unavailable, invalid, or incomplete.
- `kit triage check-skills` requires coverage evidence in the receipt for each staged skill. Rescan skills with older deep receipts.
