### Added

- **`kit check`, `kit agent-audit` and `kit agent-config` say when Claude Code's sandbox leaves the
  network open.** `kit agent-config` turns on `sandbox.enabled`. Without
  `sandbox.network.strictAllowlist`, a host outside `allowedDomains` is decided by permission mode,
  and `bypassPermissions` allows it without a prompt. The new `Claude Code sandbox network` row warns
  when the sandbox is on and neither `strictAllowlist` (user or managed settings) nor the managed
  `allowManagedDomainsOnly` is set. The warning is medium with `bypassPermissions` and low otherwise.
  A repository file cannot set the key, so kit reports it and does not write it. Setting names from
  code.claude.com/docs/en/settings-reference (kit-research `agent-vm-yolo-herdr-paseo-vs-kit`).
