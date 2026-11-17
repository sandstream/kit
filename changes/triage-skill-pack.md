### Fixed

- **`kit triage skill <dir>` triages a local skill pack.** A directory with no `SKILL.md` of its
  own, such as a pack laid out as `skills/<name>/SKILL.md`, fell through to repo triage, which
  refused it as a local path and told the operator to run `kit triage skill <dir>`, the command
  they had just run. Every `SKILL.md` up to four levels below is now triaged, with each finding
  prefixed by its skill's directory. A directory with no skill at all says so. Found in
  kit-research `pstack-vs-kit`.
