### Added

- `kit gha-audit` (and `kit check --category security`) warns on a workflow that expands every secret at once with `toJSON(secrets)`, and names the lines. The "wfx" campaign of November 2026 pushed a step of this shape into existing workflows from stolen accounts. A secret passed by name, `toJSON(vars)` and a comment are not reported.
