### Fixed

- **The Docker image scan no longer blocks every merge on npm's bundled `picomatch`.** Trivy flagged CVE-2026-112366 (HIGH, ReDoS, no patched release) in the copy of `picomatch` that ships inside npm in the image. The scan exits 1 on any HIGH finding, so `Docker Build & Push` went red on every push to `main` and the "PR + green CI" rule stopped all merges. `.trivyignore.yaml` now waives that one CVE at that one path until 2026-12-17, after which Trivy stops honouring it. A second copy of the package anywhere else in the image still fails the scan.
