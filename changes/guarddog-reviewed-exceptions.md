### Added

- **`guarddog-exceptions.json` records a reviewed GuardDog false positive, narrowly.** GuardDog has
  no ignore list, so one reviewed false positive kept the malware check red for good. An entry
  names one package at an exact version, one rule, one file in that package and the SHA-256 of the
  installed file, with a reason and an expiry date at most 90 days ahead. Changed bytes, another
  version, rule or file, a missing install or an expired entry cover nothing, and the check detail
  names each entry that did not apply. Rule errors and metadata findings cannot be excepted. Kit's
  own file covers four findings that were read and found benign: three `process.env.MCP_*` reads
  in `@modelcontextprotocol/sdk` 1.32.2 example servers and clients, and the Unicode table of the
  json5 copy bundled in `prettier` 3.10.1.
