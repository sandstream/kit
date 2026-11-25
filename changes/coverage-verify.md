### Fixed

- **`kit coverage --verify` no longer counts a control as verified when a backing check did not
  run or stopped with findings.** `evidenceFor` returned `verified` on any passing backing row and
  ignored a `warn`, so NIST 800-53 PT read "verified" because `agent transcripts` passed while
  `secrets scan`, which also backs PT, warned with findings and did not finish. A backing row with
  `didNotRun` or `hasFindings` now leaves the control `unrun` (a `fail` still makes it `failing`).
  An ordinary `warn` is unchanged. Found measuring Comp's evidence import.
- **`kit coverage --help` lists `nist-800-53`.** `--list-standards` and `--standard=nist-800-53`
  worked, but the help's `--standard=` list stopped at `gcp-waf-security`. A test now holds the
  help to every registered standard.
- **The OWASP LLM06 rationale describes the exec-broker that ships.** It said exec-time scoping
  "is on the 5.0 roadmap" while `src/exec-broker/` and `kit broker enforce` ship. It now says
  what the broker does and its limits: opt-in, declared effects only, egress only for an
  arbitrary `kit run` command.
