### Fixed

- **`kit audit anchor` no longer erases the alarm `kit audit verify` raises.** After a row was
  dropped from an anchored log, `verify` reported *truncated/rolled back*, but `kit audit anchor`
  re-sealed the shorter log without a word and `verify` went green again. The append-time
  auto-advance already refused this; the explicit command now does too, for a truncated, rewritten
  or unparseable sealed prefix. A rotated key and a first seal still seal. A person who has
  inspected the log accepts it as the new baseline with `kit audit anchor --accept-rollback`.
  Found in kit-research `agent-swarms-security-guide-vs-kit`.
