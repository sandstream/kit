### Added

- **`kit gha-audit` flags `npm ci` / `npm install` / `npm i` without `--ignore-scripts` in a job
  that holds a credential.** A job holds one when it references `${{ secrets.* }}` (in `env`,
  `with` or `run`; `secrets.GITHUB_TOKEN` counts), when the workflow-level `env:` does, or when it
  can mint an OIDC token (`id-token: write` or `write-all`, on the job or inherited from the
  workflow when the job sets no `permissions:`). npm 10 and 11 run every install script and npm 12
  still runs the project's own, so a `postinstall` added to the repository's package.json runs
  with those credentials, as in the wfx-loot campaign (2026-11). The finding is a high-severity
  warning with the file and line, and says to add `--ignore-scripts` or move the install into a
  job without secrets. npm only; other package managers are not checked.
