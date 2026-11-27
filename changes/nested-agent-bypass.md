### Security

- **`gate-bash` refuses a nested coding agent started with its approvals off.**
  `claude --print --dangerously-skip-permissions "…"`, `claude -p --permission-mode
  bypassPermissions`, `codex exec --dangerously-bypass-approvals-and-sandbox` and `gemini --yolo -p`
  all passed with exit 0, while the gate already refused `git commit --no-verify` for skipping a
  control. They now exit 2, through `sh -c`, wrappers, `npx` and the Windows shells too, and the
  refusal names the flag and how to run the agent with approvals on. Codex, Gemini, Qwen, Cursor,
  Copilot, Kiro and Droid flags are covered where their vendor documents them. The classifier,
  `src/nested-agent-bypass.ts`, is pure and exported so `agent-audit` can read permission grants
  with it. Found by kit-research `artex-cc-vs-kit`.
