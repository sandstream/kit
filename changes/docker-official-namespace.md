### Fixed

- **`kit triage docker` recognises official images again.** Docker Hub's repository API no longer
  sets `is_official` (it is `null` even for `library/nginx`), so every official image showed
  `official=False` and got the unofficial-publisher checks. An image under the `library`
  namespace, where the Docker Official Images live, now counts as official; an explicit
  `is_official: true` is still honoured.
