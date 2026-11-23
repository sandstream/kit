### Fixed

- **Trivy scan results require native scope evidence.** Kit checks package and configuration counts from the same filesystem, configuration or image scan that supplies the findings. Empty scope and incomplete evidence are reported separately, and readable findings remain available if SARIF conversion is incomplete.
