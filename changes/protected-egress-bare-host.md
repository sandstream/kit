### Fixed

- **`kit gate-egress` denies bare-host network tools as it denies a URL.** With no verified scope,
  `nc h.example 443`, `ping h.example` and `nmap -sS 10.0.0.5` passed with exit 0 while
  `curl https://h.example` was denied, and `docs/COMMANDS.md` said the gate "fails closed without a
  verified scope" (kit-research `decepticon-vs-kit`). The gate now reads the target of `nc`/`ncat`/
  `netcat`, `ping`, `nmap`, `ssh`/`scp`/`sftp`, `telnet`, `ftp`, `socat`, `dig`/`nslookup`/`host`,
  `openssl s_client -connect` and PowerShell's `Test-NetConnection`/`Invoke-WebRequest`/
  `Invoke-RestMethod`, only in the tool's target position (a hostname in a commit message, an
  `echo` or a `grep` is not one). With no verified scope it denies them with the same message as a
  URL; under a scope it allows in-scope hosts only, and an address range never matches. Loopback is
  treated as the URL path treats it: denied with no verified scope. The gate is wired for Claude
  Code only.
