### Added

- **`kit gha-audit` flags `id-token: write` granted wider than it is used.** A workflow-level grant
  (including `write-all`) lets every job without its own permissions mint an OIDC token that cloud,
  registry and signing services accept as the repository; it now warns and points the grant at the
  job that needs it. A job that grants `id-token: write` with no step from the explicit list of
  OIDC users (cloud login actions, cosign, artifact attestations, npm or PyPI publishing, Scorecard,
  Vault, direct token requests) also warns. Jobs that call a reusable workflow or a local action are
  not flagged, since kit cannot see whether they need the token. kit's own workflows pass.
