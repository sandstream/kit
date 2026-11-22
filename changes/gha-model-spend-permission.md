### Added

- `kit check` and `kit gha-audit` warn when a workflow grants `copilot-requests: write` or `models: read` at the top level. Every job without its own `permissions:` block then holds it, and can call a model on the organisation's account and send what it reads there. A grant on a single job is not reported.
