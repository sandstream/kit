---
id: ADR-0003
title: Core never imports coverage frameworks
status: accepted
---

# ADR-0003: Core / coverage isolation

## Decision

`src/coverage/*` holds vendored, curated framework mappings (OWASP ASVS,
NIST 800-53, AIUC-1, …) — evidence emitters with an unbounded growth curve
and permanent curation debt. They consume kit's check results; the check path
must never consume them. This keeps the frameworks extractable to a plugin
package (the stated direction) without core surgery.

## Consequences

Only the `coverage`/`analyze`/`self-audit` command cluster
(`src/commands/coverage.ts`) may import from `src/coverage/`. The gate loop —
check, fix, review's other stages, security scanners — stays framework-free.

```toml kit-enforce
[[forbid_import]]
import = "coverage/(registry|standard|aiuc-1|gcp-waf-security|nist-800-53)"
paths = "src/check*.ts"
message = "the check path consumes no framework mappings — coverage imports live only in the coverage command cluster (ADR-0003)"

[[forbid_import]]
import = "coverage/(registry|standard|aiuc-1|gcp-waf-security|nist-800-53)"
paths = "src/commands/check.ts"
message = "the check path consumes no framework mappings (ADR-0003)"
```
