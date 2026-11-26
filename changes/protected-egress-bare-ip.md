### Fixed

- **`kit gate-egress` denies a bare address or `localhost` given to `curl`/`wget`.** With no
  verified scope, `curl 10.0.0.5` and `curl localhost:3000` passed with exit 0 while
  `curl http://127.0.0.1` was denied: a scheme-less positional was read only when it was a domain.
  The owner decided (2026-11-26) that these fail closed too. An IPv4 or IPv6 literal (`[::1]:3000`),
  `localhost` and `host:port` given to `curl`, `wget` or PowerShell's `Invoke-WebRequest`/
  `Invoke-RestMethod` are now read like a URL's host: denied with the same message with no verified
  scope, and checked with the same matcher under one. An option's value (`-o out.json`,
  `--data 10.0.0.5`, `--noproxy localhost`, `--interface 10.0.0.9`) and `echo 10.0.0.5` are not
  targets. The test that asserted `curl localhost:3000/health` holds no target was changed to the
  new decision. The gate is wired for Claude Code only.
