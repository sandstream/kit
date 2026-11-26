### Fixed

- **`kit triage skill <pack>` no longer passes a pack whose skills it did not read.** It reads at
  most 200 skills; a pack of 201 whose last skill failed on its own printed `TRIAGE PASSED` with
  exit 0. Such a pack now ends `TRIAGE INCOMPLETE: <n> of <m> skill(s) not read` and exits
  non-zero, which the install gate does not count as a pass (kit-research `decepticon-vs-kit`).
- **`kit check` finds Dockerfiles named `<name>.Dockerfile` and `Containerfile`.** A tree whose
  only images were `containers/*.Dockerfile` made both trivy rows skip with "no Dockerfile found".
  The trivy coverage check counts those names as Dockerfiles too.
- **`kit triage repo` no longer prints a health score when no probe ran.** A local path or a
  refused GitHub API call printed "Health score: 55/100", the penalty arithmetic alone; it now
  prints "Health score: not measured (no probe ran)".
- **`docs/COMMANDS.md` says what `kit gate-egress` reads.** It said the gate "fails closed without
  a verified scope"; it reads URLs, `curl`/`wget` hosts and (under a scope) git remotes, and lets
  `nc`, `ping`, `nmap` and other tools through.

### Changed

- **`kit coverage --standard=ssdf` maps RV.2 to the tracking kit ships.** It said "GAP … not yet a
  check"; it now cites `kit check` (findings tracked to closure) and `kit heal`, and says it is
  partial.
