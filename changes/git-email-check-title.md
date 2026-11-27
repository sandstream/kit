### Fixed

- **The git e-mail row no longer reads as the opposite of its finding.** It printed
  `git user.email is a no-reply address: warn` for an address that is *not* a no-reply address. The
  row is now `git user.email no-reply`, and a warning starts with `not a no-reply address`.
