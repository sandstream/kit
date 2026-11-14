# Verify a pull

```sh
kit security verify-pull [--base <ref>] [--head <ref>] [--json]
```

`verify-pull` compares `dependencies`, `devDependencies`, `optionalDependencies`, and `peerDependencies` in every tracked `package.json`, including nested files.
Manifest JSON can start with a UTF-8 byte order mark (BOM). Malformed JSON still fails inspection.
Git tree paths must use valid UTF-8. Invalid bytes produce `invalid-path-encoding` and incomplete coverage instead of replacement characters.
It reports added, removed, and changed specifications with their file, section, name, and before/after values.
It masks recognized credentials in report values and diagnostics.
`gitignoreRemovals` preserves each removed entry's sensitivity before redaction. Verdicts and text labels use this classification, not the redacted text.
Invalid refs, Git read failures, and malformed manifests produce `severity: "fail"` and exit code 1 in text and JSON modes.
The JSON report includes typed `errors`, `coverage`, `dependencyChanges`, and separate `removedFiles`.
Unknown file scope differs from a known empty range. Deleted files have no head content to scan.
Dependency additions and specification changes remain warnings with exit code 0. They do not block installation.
Complete coverage applies only to the stated inspection scope.
The audit does not assess package reputation or malware, resolve lockfile dependencies, or enforce quarantine and pending-install restrictions.
Without a usable `ORIG_HEAD`, the existing default remains `HEAD~1`. Use `--base` to select the exact pre-pull commit.
