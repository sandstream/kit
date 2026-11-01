# Semgrep gate

How the required SAST job in `.github/workflows/security.yml` scans and what a green result does and does not prove.

The required SAST job runs Semgrep 1.176.0 with `p/security-audit`,
`p/owasp-top-ten`, `p/typescript`, and `p/nodejs`. Registry rule packs can
change independently of the pinned scanner version. The job scans each pack
separately. Each scan must report at least one rule and one scanned file.

The job runs `scripts/run-semgrep.py` with `--strict`, `--error`, `--verbose`,
and `--time`. It fails on findings, scanner errors, incomplete output, partial
parse errors, or unexpected skipped targets. A target that Semgrep reports as
skipped for exceeding 1,000,000 bytes fails the job. This size limit bounds scan
resources.
The scan permits skips from `.semgrepignore` and Git ignore rules. Semgrep may
omit ignored files, symbolic links, and unsupported file types from its report
entirely. Individual rules can also exclude paths without reporting a skip. A
green result does not prove coverage for those files or unsupported languages.
Inline `nosemgrep` comments can suppress findings as well.
Run the scan from the Git repository root with `.` as its target. Before Semgrep
starts, the job checks every tracked file and each parent path without following
symbolic links. It checks again after the scan. Missing tracked regular files and
local type changes fail the first check, including changes under ignored paths. The checks
do not protect against another process changing paths during the scan. The job
also checks tracked links
and submodules in the Git index. It does not fetch submodules. An indexed link
or submodule passes only when Semgrep reports it as ignored. Git errors and
unresolved index conflicts fail the job. A legitimate link or submodule that
Semgrep does not report as ignored requires a verifiable explicit exception. An
ignored link or submodule is not scanned.
Before each scan, the job checks ignore files without following symbolic links.
It rejects linked or special `.semgrepignore` and `.gitignore` files, even in ignored directories.
It also rejects active `:include` directives in `.semgrepignore` files.
Use regular ignore patterns instead. Comments may mention `:include`.
The job fails if it cannot inspect a directory.
Git can also read local excludes from its metadata or `core.excludesFile`.
The job does not validate those files. They can exclude untracked files.
Registry or installation failures also fail the job. The security gate requires
the SAST job to succeed.

The scan runs locally. It fetches rule packs from the Semgrep Registry with
metrics disabled. The registry still receives the requests and network metadata.
The runner removes Semgrep, SonarCloud, and GitHub token variables before it
starts the scanner. It also gives Semgrep a temporary settings file, so the
scanner cannot use a saved Semgrep token. Scanner findings and errors can include
source snippets in job logs. Review log access before adding sensitive material
to tracked files.

On Linux or macOS, run `python3 scripts/test-semgrep-gate.py` with Semgrep
1.176.0 on `PATH` to exercise the scanner and gate against local fixtures.
The fixtures skip on Windows because they use POSIX tools and file types.
The suite is split across `scripts/test-semgrep-gate.py` (scan results),
`scripts/test_semgrep_gate_links.py` (links, submodules, ignore files) and the shared
`scripts/semgrep_gate_fixtures.py`.
