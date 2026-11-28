### Fixed

- **`kit usage` no longer shows a version number as `<host>` in a refusal reason.** The rule that
  groups refusals by reason shape replaced any dotted word with `<host>`, so npm's
  *"version 1.3.0 is DEPRECATED"* read *"version <host> is DEPRECATED"*. Dotted numbers
  (`1.3.0`, `v2.1`, `1.0.0-beta.1`) now read `<version>`. Exactly four octets of 0-255 is still
  an IPv4 address and still reads `<host>`, as do host names, including ones that start with
  numeric labels (`10.0.0.1.nip.io`). Found in the kit-research note `audit-year-evidence-vs-kit`.
