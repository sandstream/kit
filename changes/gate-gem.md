### Security

- **`kit gate-bash` gates `gem install <name>` and `bundle add <name>`.** Each named gem is
  triaged with `kit triage gem` (registry age and downloads, OSV malicious-package and
  vulnerability records, the cooling period) and the command is refused (exit 2) unless triage
  passes, as `npm install <name>` is. A `--source`, `--git`, `--github`, `--pre`, `gem install -g`
  or a version requirement that is not one exact version is refused (fail-closed). Local `.gem`
  files are skipped; a bare `bundle install` is not gated. Found in kit-research
  `strutil-core-gem-worm-vs-kit`.
