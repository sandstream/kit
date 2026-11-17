### Changed

- **`enforcement gate liveness` fails an agent session in a kit-managed checkout that never
  installed the gates.** It used to say `skip` ("enforcement gates not installed in this
  checkout"), and a Claude Code cloud session in a fresh clone ran every tool call ungated behind
  that skip. With `.kit.toml` present and `CLAUDECODE=1` (Claude Code) or `CODEX_THREAD_ID`
  (Codex) in the environment, the row is now `fail` with severity high, names the session and
  says to run `kit agent-config`. Outside an agent session, or without `.kit.toml`, it still
  skips.
