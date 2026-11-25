### Fixed

- **The publish job's SBOM check requires each runtime dependency by name.** It required at least 10 components, and 7.6.0 has two runtime dependencies (`zod`, `smol-toml`), so a complete SBOM failed the check and the 7.6.0 release was published to npm without its SBOMs attached. `scripts/verify-sbom.mjs` now reads the dependencies from `package.json` and names any the CycloneDX or SPDX file leaves out.
