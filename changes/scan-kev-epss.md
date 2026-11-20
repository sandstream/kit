### Added

- `kit scan` marks each finding with CISA KEV (Known Exploited Vulnerabilities) and FIRST EPSS (exploitation probability), and lists KEV findings first. A finding whose CVE is in KEV fails the scan whatever its severity label says. osv-scanner findings now keep their CVE/GHSA `aliases`, so an npm advisory keyed by GHSA still matches KEV. Both feeds are cached for 24 hours in `~/.kit/exploit-intel.json`. A feed that cannot be read is a warning, and a failure with `--strict`. Air gap reads only the cache. Turn it off with `[scan] exploit_intel = false` or `KIT_EXPLOIT_INTEL=0`.
- `kit watch` ranks a Dependabot PR that fixes a CVE in CISA KEV first, shows `KEV` in the status line, and opens an action item for it even when its severity is medium or low.
