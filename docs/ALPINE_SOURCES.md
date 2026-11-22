# Alpine source checks

The Dockerfile floor check compares supported `apk add` version constraints with Alpine secdb fixes.
It resolves source package names through main and community indexes for the selected branch.
The current index architecture is x86_64. This check does not inspect an installed image or prove coverage for other architectures.
An unspecified branch uses the newest stable branch and reports that assumption.

## Source integrity

Each source has a 16 MiB compressed or response-body limit. Transport refuses redirects, partial responses, and certificate failures.
The archive reader permits at most 64 MiB after decompression, across all gzip members.
It permits at most 4,096 tar entries and 64 KiB per local PAX metadata entry.

Kit validates header checksums, complete numeric fields, member bodies, zero padding, and final zero blocks.
It accepts GNU and POSIX ustar headers. It accepts regular signature entries before an optional DESCRIPTION and exactly one APKINDEX.
Signature fragments need no tar end blocks. The complete archive must end with at least two complete zero blocks.
Kit validates the entire archive before it returns APKINDEX text. It rejects invalid UTF-8 text.
Kit also requires complete compressed-input consumption. It rejects residual bytes after the final gzip member, including zero padding.
This restriction prevents a zero byte from hiding another member or corrupt content from the gzip reader.

Local PAX metadata can contain mtime, atime, and ctime timestamps.
Kit rejects other PAX keys, links, special files, unknown logical members, and unsupported header types.
Two end blocks, zero member padding, and these extension restrictions define Kit's supported producer profile.
They are stricter than some tar readers. An unsupported archive leaves the check unverified.

Header checksums detect malformed structure. Kit does not authenticate the signature bytes or establish repository freshness.
HTTPS and the configured Alpine sources remain trust dependencies.

## Complete data and comparison

A secdb feed must have a packages array. Every package needs a nonempty name and a secfixes object.
Each fix version must map to an array of nonempty advisory strings. Kit rejects malformed records instead of discarding them.
Kit preserves advisory identifiers, including combined identifiers and GHSA identifiers.
It combines duplicate package and version entries, including entries from both repositories.
Empty packages, fix maps, and identifier arrays are valid. Empty identifier arrays create no advisory finding.
Nonempty strings without ASCII control characters are explicit consumer restrictions.

The origin projection requires one nonempty P and V field in each package record. It permits at most one o field.
It validates all field lines and permits additive metadata. This is not full APK installability validation.
Empty indexes are valid data. A nonempty index must end with LF.
Missing, empty, or conflicting origins remain unresolved for that package.
Other packages keep their validated origins. Multiple versions can legitimately have different source packages.
Repeated names with the same origin are valid. Unknown origins cannot acquire trust from another record with the same name.

A requested package without a resolved origin cannot pass. A version that Kit cannot compare cannot pass.
Kit keeps known findings when another comparison is incomplete. The result then has `didNotRun: true` and remains unverified.
Each branch retains its own findings and errors. A failed source or latest-branch lookup does not erase findings from explicit branches.
An incomplete comparison produces a warning, which the strict security gate rejects.

## Evidence

`alpine-index-archive.test.ts` exercises accepted formats, corruption, truncation, duplicate members, unsupported metadata, and resource limits.
`apk-index-fixture.test.ts` checks the synthetic tar writer with the operating system's tar reader.
`alpine-secdb.test.ts` and `alpine-index-origins.test.ts` cover whole-feed and whole-record validation.
`check-apk-floors-integrity.test.ts` and `check-apk-floors-coverage.test.ts` exercise the public check with real archive and JSON bytes.
`check-apk-floors-branches.test.ts` checks retained findings before and after failures in other branches.
These tests use controlled source responses. A successful fixture test does not establish the state of the public feeds.
