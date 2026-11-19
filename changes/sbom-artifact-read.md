### Fixed

- The publish job can read the workflow artifact the SBOM action attaches to the release. The 7.5.0 run uploaded the SBOM and then got "Not Found" on the download, so the release had no SBOM until it was attached by hand.
