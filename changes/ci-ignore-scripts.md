### Security

- **kit's own workflows no longer run install-time scripts in jobs that hold a secret or `id-token: write`.** `security.yml` (deps, sast, dogfood-scan), `publish.yml` and `upstream-watch.yml` now pass `--ignore-scripts`. A `postinstall` added to `package.json`, the wfx-loot campaign's delivery, would otherwise have run with `SNYK_TOKEN`, `SONAR_TOKEN`, `GITHUB_TOKEN` or the publish job's OIDC identity in reach. `src/workflow-install-scripts.test.ts` holds it.
