### Fixed

- Require format-specific audit evidence before comparing or changing a pnpm, Bun, or Yarn advisory baseline.
- Keep confirmed advisories from incomplete reports and preserve the baseline when scope cannot be verified.
- Audit Bun from a private text lockfile snapshot. Audit Yarn 4 recursively and require explicit confirmation when JSON output is empty.
