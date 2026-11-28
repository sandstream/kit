### Added

- **`kit gha-audit` warns when a `run:` step sends a secret to a host outside GitHub.** A `curl`,
  `wget`, `nc`, `socat`, `Invoke-WebRequest` or `Invoke-RestMethod` command (continuations joined)
  that carries `${{ secrets.* }}`, `${{ github.token }}` or an `env:` name set from one is reported
  (high, OWASP CICD-SEC-6) with its line, the secret and the host, unless every host it names is
  `github.com`, `api.github.com`, `uploads.github.com`, the runner's `github.api_url`, GitHub's
  package hosts, or a literal registry the workflow declares (`registry-url:`, a registry option
  on the publish command, `docker login <host>`) and publishes to. A host held in a variable, or
  no visible host, counts as outside. `with:` inputs of `uses:` steps are not read. Found by kit-research note
  agent-vm-yolo-herdr-paseo-vs-kit.
