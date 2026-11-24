### Fixed

- The malware-shape rule for agent hooks and status lines matched only a download piped into `sh`, `bash` or `zsh`. It now also matches a download piped into `python3`, `node`, `perl`, `ruby` or PowerShell, PowerShell's `irm … | iex` and `iex (iwr …)` (kit runs on Windows), and a download saved and then run (`curl -o f … && sh f`, `chmod +x f && ./f`). The saved path has to be what runs next, so `curl -o out.json … && node build.js` is not flagged.
