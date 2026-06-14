#!/usr/bin/env bash
# no-internal-leaks.sh — keep private/internal references out of a
# public-bound repository.
#
# Scans content against a list of internal terms (private codenames, internal
# hostnames, non-public emails, not-for-publication markers). The term list is kept
# OUTSIDE the repo so the list itself never leaks into the public history.
#
# Audit lesson this encodes: a leak hides not only in files but in the COMMIT
# MESSAGE — a "scrub" commit whose own message named every codename it removed.
# So this guards staged content AND commit messages AND existing history.
#
# Modes:
#   --staged        scan the staged blob content              (pre-commit)
#   --msg <file>    scan a commit-message file                (commit-msg)
#   --tracked       scan every tracked file                   (pre-push / manual)
#
# Term-list resolution (first existing file wins):
#   1. $INTERNAL_TERMS_FILE
#   2. <repo-root>/.internal-terms      (keep gitignored — local only)
#   3. ~/.config/dev-standard/internal-terms
#
# Term-list format: one term per line; blank lines and '#' comments ignored;
# each term matched case-insensitively as a FIXED string (not a regex), so
# special characters are safe and there are no surprise expansions.
#
# No term list found  -> warn once to stderr, exit 0 (fail-open: a repo that
#                         hasn't configured a list is never blocked).
# Match found          -> print location(s) + the offending line, exit 1.
# Clean                -> silent, exit 0.
set -euo pipefail

MODE="${1:-}"
MSG_FILE="${2:-}"

die_usage() {
  echo "usage: no-internal-leaks.sh (--staged | --msg <file> | --tracked)" >&2
  exit 2
}
[ -n "$MODE" ] || die_usage

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"

# --- resolve the term list ---------------------------------------------------
TERMS_FILE=""
for cand in \
  "${INTERNAL_TERMS_FILE:-}" \
  "${REPO_ROOT:+$REPO_ROOT/.internal-terms}" \
  "$HOME/.config/dev-standard/internal-terms"; do
  if [ -n "$cand" ] && [ -f "$cand" ]; then TERMS_FILE="$cand"; break; fi
done

if [ -z "$TERMS_FILE" ]; then
  echo "no-internal-leaks: no term list found — set INTERNAL_TERMS_FILE or create ~/.config/dev-standard/internal-terms (skipping)" >&2
  exit 0
fi

# Strip comments/blank lines into a temp pattern file for grep -f.
PAT_FILE="$(mktemp)"
trap 'rm -f "$PAT_FILE"' EXIT
grep -vE '^[[:space:]]*(#|$)' "$TERMS_FILE" > "$PAT_FILE" || true
if [ ! -s "$PAT_FILE" ]; then exit 0; fi   # empty list = nothing to enforce

HITS=0

report() {  # $1 = location label, $2 = matched lines (grep -ni output)
  echo "  ✗ $1" >&2
  printf '%s\n' "$2" | sed 's/^/      /' >&2
  HITS=1
}

case "$MODE" in
  --staged)
    # Scan the STAGED blob of each added/copied/modified file (not the worktree),
    # so what the hook checks is exactly what would be committed.
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      match="$(git show ":$f" 2>/dev/null | grep -niF -f "$PAT_FILE" || true)"
      [ -n "$match" ] && report "$f" "$match"
    done < <(git diff --cached --name-only --diff-filter=ACM)
    ;;
  --msg)
    [ -n "$MSG_FILE" ] && [ -f "$MSG_FILE" ] || die_usage
    match="$(grep -niF -f "$PAT_FILE" "$MSG_FILE" || true)"
    [ -n "$match" ] && report "commit message" "$match"
    ;;
  --tracked)
    match="$(git grep -nIiF -f "$PAT_FILE" -- . 2>/dev/null || true)"
    [ -n "$match" ] && report "tracked files" "$match"
    ;;
  *)
    die_usage
    ;;
esac

if [ "$HITS" -ne 0 ]; then
  echo "" >&2
  echo "no-internal-leaks: blocked — internal term(s) found above (list: $TERMS_FILE)." >&2
  echo "  Remove/generalize the reference, or if it is a false positive, scope the" >&2
  echo "  term in the list. Bypassing this guard requires explicit approval." >&2
  exit 1
fi
exit 0
