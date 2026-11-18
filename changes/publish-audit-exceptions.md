### Fixed

- The release workflow's `npm audit` step now reads `audit-exceptions.json` like the other audit gates, through `scripts/npm-audit-gate.mjs`. Without it, a high advisory with no patched version (today: `picomatch` GHSA-fc5q-39xc-vjpf, dev toolchain only) blocked every release while all other checks were green. The step is unchanged in strictness: the threshold stays high, only a named advisory with a reason and an end date within 90 days is covered, and a build step now runs before it because the gate reads its rules from `dist`.
