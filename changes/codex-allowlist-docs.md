### Fixed

- **The docs no longer say Codex has no command allowlist.** `docs/FEATURES.md` and a comment in `src/agent-config.ts` said so, but Codex runs `prefix_rule(..., decision="allow")` rules from `~/.codex/rules/` and `<repo>/.codex/rules/` outside the sandbox without prompting. kit neither writes nor audits those rules yet; `agent-audit` reads Claude Code `permissions.allow` only. Found by kit-research#239.
