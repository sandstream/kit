### Added

- **`kit triage npm` warns when the version comes from a prerelease channel.** `pkg@canary`, `pkg@next` or any dist-tag other than `latest`, and an exact pin such as `1.2.3-canary.4`, now cost a warning: such a channel publishes far more often than `latest` and is not what `latest`'s track record vouches for.
