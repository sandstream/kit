### Fixed

- **`kit check --json` and `kit ci --format json` now carry each security row's `rule`, `files`
  and `suggestion`.** The text table printed the CWE/OWASP citation (`[CWE-798]`), the affected
  files and the remediation, but `securityCheckToJson` copied neither, so a JSON consumer (a GRC
  importer, a CI annotation) got no citation and no file list. The GitHub annotation now names the
  first file too. Found measuring Comp's evidence import.
- **The secrets fallback names its files in `kit ci --format text` and in JSON.** "N file(s) with
  unverified secret-shaped strings" listed the files only in `kit check`'s table; `kit ci`'s text
  rows and every JSON row gave the count alone. The text row now lists the first five files and
  counts the rest, as `kit check` does.
