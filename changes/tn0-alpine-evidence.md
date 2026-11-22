### Fixed

- `alpine apk floors` no longer passes on partial Alpine data. A truncated or concatenated APKINDEX archive, invalid UTF-8, a malformed secfixes record, an unknown or conflicting origin, an HTTP 206 response and an unreachable branch each keep the comparison unverified. Community advisories and the community index are now read too, so a community subpackage is compared with its own advisories.
- `alpine apk floors` reports a Dockerfile it cannot read as unverified. Before, it dropped that file's floors, and a repository whose only Dockerfile was unreadable showed "no apk add version floors".
- A pass names the Alpine branches it was checked on and the four sources it read.
