### Fixed

- Kit checks the exit status and report structure for OSV and Trivy security checks.
- Reports with incomplete coverage retain readable findings and keep the security gate unverified.
- Trivy requires a result for the relevant scan type before it reports no findings.
