### Fixed

- **`gate-bash` refuses PowerShell's `irm <url> | iex` as it refuses `curl <url> | bash`.**
  `irm`/`iwr`/`Invoke-RestMethod`/`Invoke-WebRequest` or `(New-Object Net.WebClient).DownloadString`
  piped into, or wrapped in, `iex`/`Invoke-Expression` passed with exit 0, also inside
  `powershell -c "…"` and whatever the hook's `tool_name`. It now exits 2 with the same
  `UNVERIFIED COMMAND: irm | iex runs decoded or downloaded text …` refusal, and a GitHub-hosted
  script is triaged as its repository. `agent-audit` and the gate share one pattern
  (kit-research `decepticon-vs-kit`).
