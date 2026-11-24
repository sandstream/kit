### Fixed

- Audit writers verify the existing seal under the log lock before they append.
  They refuse a truncated, missing, or unverifiable sealed log and preserve the evidence.
  The check also applies when automatic seal updates are disabled.
