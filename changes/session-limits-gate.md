### Added

- **`kit gate-limits`: per-session limits on time, tool calls and child agents.**
  `[governance.agent]` takes `max_session_minutes`, `max_tool_calls_per_session` and
  `max_child_agents`. The gate (opt in with `kit agent-config --limits-gate`, matcher `*`) counts
  each session's calls in `~/.kit/sessions/` and refuses, with an audit row, once a limit is
  reached. It allows everything until a limit is set. Parallel calls of one session can pass a
  limit by the number running at once. Found in kit-research `agent-swarms-security-guide-vs-kit`.
