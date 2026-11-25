### Fixed

- **One oversized file no longer marks unrelated code-guardrail rows as "did not run".** The
  three rows in `src/check-code-guardrails.ts` shared one error list, so a 300 KB `.tsx` made
  `public cloud command` and `literal Dockerfile secret` `didNotRun` although neither reads a
  `.tsx`, and under `kit ci`'s strict default each became a failure. A file that cannot be read now
  marks only the rows that read it, and an oversized file is named as skipped (`skipped
src/logos.tsx (over 256 KB)`). A directory-walk error still marks all three. Found measuring
  Comp.
- **The "looked in the wrong place" escalation names only ecosystems that are below.** With only
  `sub/requirements.txt`, npm audit, license check, install-script grants and `trivy fs (jvm)`
  said "no package.json found — but 1 project(s) below do". Nested projects now keep the manifests
  found in them, and a skip is escalated only toward projects holding a manifest its scanner reads
  (`no lockfiles` still counts every project).
- **`trivy container scan` finds a Dockerfile below the root.** It looked only for `./Dockerfile`
  and said "no Dockerfile found" for `app/Dockerfile`, which `trivy config (IaC)` found in the same
  run. It now uses the same three-level discovery.
- **An unknown `.kit.toml` section warns once per command.** `loadConfig` runs several times per
  command, and the `[project]` warning printed 6 to 9 times in one `kit check`; it is now
  de-duplicated per file and key, as unknown `[browser]` keys already were.
