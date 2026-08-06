<!-- BEGIN kit (managed block — edit outside the markers, not inside) -->

## kit

This repo is managed by [kit](https://github.com/sandstream/kit) (env, secrets, security gates). Hooks enforce the hard rules; what you need to know:

- If `kit` is missing (fresh clone/machine): `npm i -g sandstream-kit`, then continue below.
- Start: `kit check` — on `fail`, run `kit fix`, then re-check.
- Prior decisions: `kit memory search "<query>"` (cross-session, cross-agent).
- Secrets: `kit secrets` (vault-backed); placeholders go in `.env.example`, never plaintext in `.env*`.
- Deploy env: `[deploy]` declares required platform key names; `kit check --category deploy` diffs remote names without reading values.
- Deps the install gate hasn't covered (git repos, URLs, vendored code): `kit triage repo <target>` first.
- After a batch of edits: `kit check --category security`; halt and surface findings on `fail`.
- Everything else: `kit --help` — the commands are self-documenting.

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
