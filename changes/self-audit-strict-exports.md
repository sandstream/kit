### Fixed

- Main failed `kit self-audit` and every open pull request with it. `ENV_DENY_RULES`, `GIT_DENY_RULES` and `mergeSandbox` in `src/agent-config-strict.ts` were exported but used only inside their own file, which rule R16 refuses. They are no longer exported.
