### Added

- **`kit ingest osv` says whether the project's own source imports each vulnerable package.** Every
  OSV finding now carries one deterministic fact beside it: `imported by project source: a.ts, b.ts
  (+N more)`, `not imported by project source; in the lockfile as a dependency of <pkg>`, `not
  imported by anything kit read (dynamic or generated imports are not seen)` or `import use not
  checked: <reason>`. In `--json` it is the additive `importFact` field, next to a `package` field
  with the name and ecosystem from the report. It is a text-level read of npm/Node and Python
  source in the current directory, with no model and no network, built once per run, and it never
  changes a finding's severity, status or order. When the walk hits its bound, the lockfile cannot
  be read or a PyPI name may differ from its import name, the answer is "not checked", never a
  negative claim. `kit scan` and `kit check` do not print the fact yet (kit-research
  `owasp-xpsd-vs-kit`).
