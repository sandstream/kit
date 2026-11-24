### Fixed

- **`SECURITY.md` names 7.5.x as the supported release line.** Its table said 6.12.x received security fixes and every older version should upgrade to it, while kit shipped 7.5.0; it was last edited for 6.12.1. `src/security-supported-version.test.ts` fails when the supported row does not name the major.minor line in `package.json`, and `docs/RELEASING.md` says to update the table on a minor or major release.
