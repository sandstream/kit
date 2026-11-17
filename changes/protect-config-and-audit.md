### Changed

- **`src/config.ts` and `src/audit.ts` are protected paths** (class `permissions`). The config every gate is configured from (132 importers) and the audit log every gate deny is written to were approved by the review bot on green checks alone, like a file nothing imports. A change to either now needs the owner.
