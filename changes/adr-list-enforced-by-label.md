### Fixed

- **`kit adr list` no longer labels an ADR held by `enforced_by` files "documented, not enforced".** ADR-0009 printed that label above the two tests that enforce it. It now reads *enforced outside the grammar (N files)*, and the lines under it say *enforced by* (not *also*) when there is no `kit-enforce` rule.
