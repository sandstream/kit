### Fixed

- `kit check` now reports a model endpoint redirected away from the vendor (`ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL` and the others) and a code-loading variable (`NODE_OPTIONS` and the others), from the process environment and the Claude settings `env` blocks. Only `kit agent-audit` reported them; `kit check` printed "agent-audit: no issues" for a settings file that sent every prompt to another host. Plain HTTP to another host is a failure, as it already was in `kit agent-audit`.
- The endpoint row's detail was not a sentence ("sends model traffic a host that is not the vendor's receives …"). It now reads "`ANTHROPIC_BASE_URL`: a host that is not the vendor's receives every prompt, tool result and secret the agent reads".
