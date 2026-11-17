### Fixed

- **`kit triage npm` names the install scripts a package runs.** A package with a `postinstall` passed 100/100 without a word, though the registry metadata triage already reads declares it. The report now states which of `preinstall`, `install` and `postinstall` it runs, as a warning that costs score like any other.
- **`kit triage npm`'s help no longer claims a GitHub health check.** The npm path reads the registry only; the help said "registry + GitHub health".
