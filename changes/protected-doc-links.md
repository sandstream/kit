### Fixed

- **The pull request template links `CONTRIBUTING.md` by its full URL, and `docs/RELEASING.md` names the `SECURITY.md` step.** The template's relative link resolved against the pull request's own address once its text became a PR body, so every PR that kept the checklist carried a link that went nowhere. The release prepare step now says to name the new release line in `SECURITY.md`'s supported versions on a minor or major release.
