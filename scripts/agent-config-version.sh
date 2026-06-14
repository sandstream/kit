#!/usr/bin/env bash
# agent-config-version.sh — cut a new version of your agent-config bundle.
#
# WHY: A portable agent-config bundle (skills + lock + changelog) synced across
# machines needs a deterministic upgrade path: bump a version, re-pin every
# skill's content hash so drift is detectable, and record what changed. This is
# the release command that ties skills-lock.json and CHANGELOG.md together so
# "which version is this machine on, and what moved?" always has an answer.
#
# WHAT IT DOES (in order):
#   1. Compute the next semver from the current skills-lock.json + the bump kind.
#   2. Re-pin content hashes by delegating to skills-hash-verify.sh update
#      (single source of the hashing algorithm — never reimplemented here).
#   3. Stamp the new top-level version + generatedAt, and set each skill's
#      `version` to the release version, into skills-lock.json.
#   4. Promote the CHANGELOG `Unreleased` section to a dated `[x.y.z]` release and
#      open a fresh empty `Unreleased` stub above it.
#
# IDEMPOTENT-ish: re-running with the same bump after a release is a no-op on the
# changelog header (it refuses to release an empty Unreleased unless --allow-empty).
#
# Exit codes: 0 done · 1 refused (e.g. empty changelog, drift unresolved) · 2 usage.
#
# Usage:
#   agent-config-version.sh <major|minor|patch>
#   agent-config-version.sh --set 1.2.0
#   agent-config-version.sh minor --lock ./skills-lock.json --changelog ./CHANGELOG.md \
#                                 --skills-dir ./.agents/skills [--allow-empty] [--dry-run]
#
set -euo pipefail

PROG="$(basename "$0")"
HERE="$(cd "$(dirname "$0")" && pwd)"
LOCK="./skills-lock.json"
CHANGELOG="./CHANGELOG.md"
SKILLS_DIR=""
HASH_VERIFY="$HERE/skills-hash-verify.sh"
BUMP=""
SET_VERSION=""
ALLOW_EMPTY=0
DRY_RUN=0

die() { printf '%s: error: %s\n' "$PROG" "$1" >&2; exit 2; }

while [ $# -gt 0 ]; do
  case "$1" in
    major|minor|patch) BUMP="$1"; shift;;
    --set)             SET_VERSION="${2:?}"; shift 2;;
    --lock)            LOCK="${2:?}"; shift 2;;
    --changelog)       CHANGELOG="${2:?}"; shift 2;;
    --skills-dir)      SKILLS_DIR="${2:?}"; shift 2;;
    --hash-verify)     HASH_VERIFY="${2:?}"; shift 2;;
    --allow-empty)     ALLOW_EMPTY=1; shift;;
    --dry-run)         DRY_RUN=1; shift;;
    -h|--help)         sed -n '2,33p' "$0"; exit 0;;
    *)                 die "unknown arg: $1";;
  esac
done

[ -n "$BUMP" ] || [ -n "$SET_VERSION" ] || die "specify a bump (major|minor|patch) or --set X.Y.Z"
[ -f "$LOCK" ]       || die "lock file not found: $LOCK (copy templates/skills-lock.json)"
[ -f "$CHANGELOG" ]  || die "changelog not found: $CHANGELOG (copy templates/CHANGELOG.md)"
[ -x "$HASH_VERIFY" ] || command -v bash >/dev/null 2>&1 || die "skills-hash-verify.sh not runnable: $HASH_VERIFY"
command -v python3 >/dev/null 2>&1 || die "python3 required"

# ---- compute current + next version -------------------------------------------
CUR="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("version","0.0.0"))' "$LOCK")"

next_version() {
  python3 - "$CUR" "$BUMP" "$SET_VERSION" <<'PY'
import re, sys
cur, bump, explicit = sys.argv[1], sys.argv[2], sys.argv[3]
if explicit:
    if not re.fullmatch(r"\d+\.\d+\.\d+", explicit):
        sys.exit("error: --set must be X.Y.Z")
    print(explicit); raise SystemExit
m = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)", cur or "0.0.0")
if not m: sys.exit(f"error: current version not semver: {cur!r}")
a, b, c = map(int, m.groups())
if   bump == "major": a, b, c = a + 1, 0, 0
elif bump == "minor": b, c = b + 1, 0
elif bump == "patch": c = c + 1
else: sys.exit(f"error: unknown bump {bump!r}")
print(f"{a}.{b}.{c}")
PY
}
NEW="$(next_version)"
TODAY="$(date -u +%Y-%m-%d)"
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '== agent-config-version: %s -> %s (%s) ==\n' "$CUR" "$NEW" "$TODAY"

if [ "$DRY_RUN" -eq 1 ]; then
  echo "DRY-RUN: would re-pin hashes, set version=$NEW in $LOCK, and release [$NEW] in $CHANGELOG"
  exit 0
fi

# ---- step 1: re-pin content hashes via the canonical hasher --------------------
# Delegate hashing to skills-hash-verify so the algorithm lives in exactly one place.
HV_ARGS=(--lock "$LOCK")
[ -n "$SKILLS_DIR" ] && HV_ARGS+=(--skills-dir "$SKILLS_DIR")
echo "-- re-pinning skill hashes (skills-hash-verify update) --"
bash "$HASH_VERIFY" "${HV_ARGS[@]}" update

# ---- step 2: stamp version (top-level + per-skill) into the lock ---------------
python3 - "$LOCK" "$NEW" "$NOW" <<'PY'
import json, sys
lock_path, new, now = sys.argv[1], sys.argv[2], sys.argv[3]
lock = json.load(open(lock_path))
lock["version"] = new
lock["generatedAt"] = now
for entry in lock.get("skills", {}).values():
    entry.setdefault("version", new)
    entry["version"] = new
json.dump(lock, open(lock_path, "w"), indent=2, ensure_ascii=False)
open(lock_path, "a").write("\n")
PY
echo "-- stamped version $NEW into $LOCK --"

# ---- step 3: promote CHANGELOG Unreleased -> [NEW] - DATE, open fresh stub ------
python3 - "$CHANGELOG" "$NEW" "$TODAY" "$ALLOW_EMPTY" <<'PY'
import re, sys
path, new, today, allow_empty = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4] == "1"
text = open(path).read()

m = re.search(r"(?im)^##\s*\[Unreleased\].*?$", text)
if not m:
    sys.exit("error: no '## [Unreleased]' heading in changelog")
start = m.start()
# Body of Unreleased = everything up to the next '## ' heading (or EOF).
nxt = re.search(r"(?m)^##\s", text[m.end():])
body_end = m.end() + (nxt.start() if nxt else len(text) - m.end())
unreleased_body = text[m.end():body_end]

# Refuse an empty release (only headings, no bullet content) unless allowed.
has_content = bool(re.search(r"(?m)^\s*[-*]\s+\S", unreleased_body))
if not has_content and not allow_empty:
    sys.exit("error: Unreleased section has no entries; add notes or pass --allow-empty")

UNRELEASED_STUB = (
    "## [Unreleased]\n\n"
    "### Added\n\n### Changed\n\n### Deprecated\n\n"
    "### Removed\n\n### Fixed\n\n### Security\n\n"
)
released_header = f"## [{new}] - {today}\n"
new_block = UNRELEASED_STUB + released_header + unreleased_body
text = text[:start] + new_block + text[body_end:]

# Maintain comparison links at the bottom if the template's pattern is present.
if re.search(r"(?m)^\[Unreleased\]:\s*\S+compare/\S+", text):
    base = re.search(r"(?m)^\[Unreleased\]:\s*(\S+)compare/", text).group(1)
    text = re.sub(r"(?m)^\[Unreleased\]:.*$",
                  f"[Unreleased]: {base}compare/v{new}...HEAD", text)
    rel = f"[{new}]: {base}releases/tag/v{new}"
    if f"\n[{new}]:" not in text:
        text = re.sub(r"(?m)^(\[Unreleased\]:.*)$", r"\1\n" + rel, text, count=1)

open(path, "w").write(text)
PY
echo "-- released [$NEW] in $CHANGELOG (fresh Unreleased stub opened) --"

echo "------------------------------------------"
echo "DONE  agent-config bundle is now v$NEW."
echo "      review: git diff -- $LOCK $CHANGELOG"
echo "      then tag: git commit -am \"chore(release): v$NEW\" && git tag v$NEW"
