### Fixed

- **`kit agent-audit` and `kit triage skill` judge a package runner's pin per ecosystem.** Both
  called a spec pinned when the text after its last `@` started with a digit (kit-research
  `auto-ontology-vs-kit`). So `uvx --from auto-ontology-mcp==1.3.0` (an exact PyPI pin) and a git
  source pinned by a full commit that starts with a letter read unpinned, while a branch whose
  name starts with a digit (`git+https://…@2026-dev`) read pinned. Pinned now means npm
  `name@1.2.3` (an exact semver), PyPI `name==1.2.3` or uv's `name@1.2.3`, and a git source only by
  a full 40- or 64-hex commit; ranges, tags, branches and anything ambiguous are unpinned. The
  package is read from `--from` (also `--from=`), `--package`/`-p` for npm runners and `--spec`,
  and uv's `--python <v>` is no longer taken for the package. The advice says `@<commit>` (or
  npm's `#<commit>`) for a git source and `name==1.2.3` for PyPI. The two twins are tested on one
  shared list of launches.
