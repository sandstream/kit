### Fixed

- `kit broker enforce` records the request before it writes the profile when audit logging is enabled.
  It refuses the update if that write fails, including with `--force`.
- Kit prepares the new signature before it writes the profile. It verifies the published signature
  before it reports enforcement as active.
- If the audit log cannot record the completed transition, Kit reports the active state and exits 1.
  A retry can complete a sealed request that matches the installed, verified profile.
