#!/usr/bin/env bash
# Reads a unified diff of package-lock.json on stdin and prints every package version the diff
# ADDS, one `name@version` per line, sorted and unique. Used by .github/workflows/triage-deps.yml.
#
# The version is part of the output on purpose: triage then checks the exact version the lockfile
# will install, not whatever `latest` happens to be. Scoped packages keep their scope: the registry
# URL is `.../@scope/name/-/name-1.2.3.tgz`, and taking only the first path segment yields the bare
# `@scope`, which fails the name check and was skipped untriaged.
set -euo pipefail

# POSIX sed, not `grep -P`: BSD grep on macOS has no -P. BSD sed adds no newline after the last
# line of input that has none, so the loop below also handles a final unterminated line.
sed -n -E 's#^\+[[:space:]]*"resolved":[[:space:]]*"https://registry\.npmjs\.org/([^"]+\.tgz).*#\1#p' |
  while IFS= read -r path || [ -n "$path" ]; do
    name="${path%%/-/*}"
    file="${path##*/}"
    base="${name##*/}"
    version="${file#"$base"-}"
    version="${version%.tgz}"
    printf '%s@%s\n' "$name" "$version"
  done |
  sort -u
