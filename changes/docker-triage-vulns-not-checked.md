### Fixed

- **`kit triage docker` says it does not check the image's vulnerabilities.** Docker Hub metadata
  lists no packages, so `nginx:1.31.8` passed 100/100 with nothing said, though it carries the
  HTTP/2 RCEs CVE-2026-123633 and CVE-2026-123007 (fixed in 1.31.9 / 1.30.7). Every docker triage
  now prints `NOT CHECKED: known vulnerabilities in the image` and points at `kit scan` (trivy,
  osv-scanner), so the coverage line reads PARTIAL. When a run mixes a probe the ecosystem cannot
  answer with one whose source was unreachable, the coverage line now names both groups instead of
  calling both permanent. Found in kit-research `nginx-http2-rce-and-oss-scanner-vs-kit`.
