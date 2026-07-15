<!-- BEGIN kit (managed block — edit outside the markers, not inside) -->

## kit

This project uses [kit](https://github.com/sandstream/kit) to manage tools, secrets, and environment setup. The hard rules are ENFORCED by hooks, not this text: the session-start hook injects the kit statusline (setup score · update mark · open-PAL count) as context, and PreToolUse gates block un-triaged package installs and plaintext secrets aimed at `.env*` before they happen. As the agent working here:

- Run `kit check` before starting; if it reports `fail`, run `kit fix` then re-check.
- Recall prior decisions with `kit memory search "<query>"` (cross-session, cross-agent).
- Resolve secrets with `kit secrets` (vault-backed); put placeholders in `.env.example` — the env-gate blocks plaintext `.env*` writes.
- For dependencies outside the install-gate's reach (git repos, URLs, vendored code), run `kit triage repo <target>` first.
- After a batch of edits, run `kit check --category security`; halt and surface findings on `fail`.
- Destructive secret ops require `kit auth elevate` first (the CLI enforces this).

<!-- END kit -->

## Public artifacts — issue & PR hygiene

`sandstream/kit` is a **public** repository. When opening issues or PRs here:

- **Never put a `claude.ai/code/session_…` URL in an issue or PR body.** It is
  internal session metadata, not useful to readers, and it clutters the public
  record (it accumulated on ~160 existing artifacts). The only footer to use is
  the generic `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- No internal session IDs, private dashboard/console links, or paths under
  another customer's project in public bodies.
- Findings that could be a real security leak in a named third-party repo go to
  the private `sandstream/kit-research` repo, never a public kit issue.
