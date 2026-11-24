### Fixed

- Broker readiness distinguishes a missing audit log, an empty log, and a log without observe events.
- `kit broker enforce-readiness --json` reports the cause in `untestedReason`.
