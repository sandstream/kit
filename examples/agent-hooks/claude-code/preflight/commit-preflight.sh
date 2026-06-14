#!/usr/bin/env bash
# commit-preflight.sh — fast git-commit pre-flight (Claude Code: PreToolUse).
#
# Fires BEFORE the agent runs a bash action containing `git commit`. Blocks
# (exit 2) the cheap-to-check, high-value violations so they never reach the
# heavier native git hook:
#   1. `git commit --no-verify` / `-n`  → bypassing the gate is forbidden.
#   2. Staged .env* files               → never commit secrets.
#   3. Secret pattern in the staged diff → catch before it lands.
#
# Reads the harness PreToolUse JSON on stdin ({"tool_input":{"command":...}}).
# If jq is unavailable it parses with python3, then a grep fallback.
# Exit 0 = allow; exit 2 = deny. Non-commit commands pass through.
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

# Only intercept git commit.
printf '%s' "$COMMAND" | grep -q 'git commit' || exit 0

ERRORS=""

# 1. Refuse --no-verify / -n — never bypass the gate.
if printf '%s' "$COMMAND" | grep -qE -- '--no-verify\b|(^| )-[a-zA-Z]*n([a-zA-Z]*)?( |$)'; then
  ERRORS="${ERRORS}\n- 'git commit --no-verify/-n' is forbidden. Fix the underlying issue instead of skipping the gate."
fi

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$PROJECT_DIR" || exit 0

# 2. Refuse staged .env* files.
if git diff --cached --name-only 2>/dev/null | grep -qE '(^|/)\.env(\.|$)'; then
  ERRORS="${ERRORS}\n- A staged file matches the .env* pattern. Unstage it: git restore --staged <file>"
fi

# 3. Secret pattern in the staged diff (same tight pattern as the START-gate).
staged=$(git diff --cached 2>/dev/null | grep '^+' | grep -v '^+++' || true)
if printf '%s\n' "$staged" | grep -qE \
     'sk_live_[A-Za-z0-9]{8,}|sk-ant-[A-Za-z0-9_-]{8,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|xox[bap]-[A-Za-z0-9-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----' \
   || printf '%s\n' "$staged" | grep -qiE \
     '(STRIPE_SECRET_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|GITHUB_TOKEN|AWS_SECRET_ACCESS_KEY)[[:space:]]*[:=][[:space:]]*["'"'"']?[A-Za-z0-9+/=_-]{16,}'; then
  ERRORS="${ERRORS}\n- Possible SECRET in the staged diff. Remove it and move the value to a secret store before committing."
fi

if [ -n "$ERRORS" ]; then
  printf "Commit pre-flight FAILED:%b\n" "$ERRORS" >&2
  exit 2
fi
exit 0
