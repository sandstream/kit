### Added

- `kit check` has a row for credentials that sit in plaintext in the home directory, the files an infostealer collects: AWS, npm, netrc, Postgres, PyPI, git, Docker, GitHub CLI, gcloud, Kubernetes, Terraform, Claude Code, Codex and kit's own MCP tokens, plus SSH keys without a passphrase. It lists each file with how long since it was written, and warns when one is 90 days old or more, or readable by other accounts. It never reads a value out and makes no network request.
