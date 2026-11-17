### Added

- **`kit panic --stop` stops every gated agent on the machine.** It writes `~/.kit/stop`; every
  PreToolUse gate (`gate-bash`, `gate-env`, `gate-egress`, `gate-fs`) then refuses every tool call
  before any other decision, and audits the refusal, until a person runs `kit panic --resume`.
  An unreadable marker still stops. It does not rotate keys (plain `kit panic` does), and agents
  without kit's gates are not stopped. Found in kit-research `agent-swarms-security-guide-vs-kit`:
  `kit panic` did not stop agents that were already running.
