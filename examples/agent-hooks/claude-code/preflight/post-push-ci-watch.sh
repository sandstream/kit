#!/usr/bin/env bash
# post-push-ci-watch.sh — non-blocking CI watcher (Claude Code: PostToolUse).
#
# Fires AFTER a successful `git push`. If the GitHub CLI (`gh`) is available
# and authenticated, it kicks off a detached, background-safe watch of the
# latest CI run for the pushed branch and writes a one-line status note to a
# log the agent can read on a later turn. Purely advisory:
#   - NEVER blocks (always exit 0).
#   - No-ops cleanly when gh is missing, unauthenticated, or no run is found.
#
# The note lands in CI_WATCH_LOG (default .git/.kit/ci-watch.log).
set -euo pipefail

INPUT=$(cat 2>/dev/null || echo '{}')
extract_cmd() {
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null && return
  fi
  printf '%s' "$INPUT" | python3 -c "import sys,json
try: print(json.load(sys.stdin).get('tool_input',{}).get('command',''))
except Exception: print('')" 2>/dev/null || printf '%s' "$INPUT"
}
COMMAND=$(extract_cmd)

# Only act on a git push, and only if gh exists.
printf '%s' "$COMMAND" | grep -q 'git push' || exit 0
command -v gh >/dev/null 2>&1 || exit 0

root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
cd "$root" || exit 0

# Confirm gh is usable in this repo (auth + remote). No-op otherwise.
gh auth status >/dev/null 2>&1 || exit 0

LOG="${CI_WATCH_LOG:-.git/.kit/ci-watch.log}"
mkdir -p "$(dirname "$LOG")" 2>/dev/null || true
branch=$(git branch --show-current 2>/dev/null || echo "")
[ -z "$branch" ] && exit 0

# Detached watcher: poll the latest run for this branch, append one status
# line when it settles. Self-contained so it survives the hook returning.
(
  set +e
  ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
  printf '[%s] CI watch started: branch=%s\n' "$(ts)" "$branch" >> "$LOG"
  # Give the run a moment to register, then poll up to ~10 min.
  for _ in $(seq 1 60); do
    sleep 10
    json=$(gh run list --branch "$branch" --limit 1 \
      --json status,conclusion,displayTitle,url 2>/dev/null) || continue
    [ -z "$json" ] || [ "$json" = "[]" ] && continue
    status=$(printf '%s' "$json" | python3 -c "import sys,json;r=json.load(sys.stdin);print(r[0].get('status','') if r else '')" 2>/dev/null)
    if [ "$status" = "completed" ]; then
      printf '%s' "$json" | python3 -c "import sys,json
r=json.load(sys.stdin)[0]
print('[%s] CI %s: %s  %s' % ('$(ts)', r.get('conclusion','?'), r.get('displayTitle',''), r.get('url','')))" \
        >> "$LOG" 2>/dev/null
      exit 0
    fi
  done
  printf '[%s] CI watch timed out (run still in progress on %s)\n' "$(ts)" "$branch" >> "$LOG"
) >/dev/null 2>&1 &
disown 2>/dev/null || true

exit 0
