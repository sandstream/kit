#!/usr/bin/env bash
# push-preflight.sh — git-push pre-flight (Claude Code: PreToolUse).
#
# Fires BEFORE the agent runs a bash action containing `git push`. Catches the
# "passes locally, fails in CI" class of problems and the forbidden bypasses:
#   1. `git push --force/-f` to a protected branch → forbidden without approval.
#   2. `git push --no-verify`                      → never bypass the gate.
#   3. Build + test, IF package.json declares those scripts (else skipped).
#   4. Secret pattern in commits about to be pushed.
#   5. Untracked source files imported by tracked code (CI breaker).
#
# Exit 0 = allow; exit 2 = deny. Non-push commands pass through.
# Generic: source roots come from SOURCE_GLOBS, protected branches from
# PROTECTED_BRANCHES. Set PUSH_SKIP_BUILD=1 to skip the build/test step.
set -euo pipefail

PROTECTED_BRANCHES="${PROTECTED_BRANCHES:-main master}"
# Space-separated git pathspecs for source files (any language).
SOURCE_GLOBS="${SOURCE_GLOBS:-src/**/*.ts src/**/*.tsx src/**/*.js src/**/*.jsx app/**/*.ts app/**/*.tsx lib/**/*.ts}"

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

printf '%s' "$COMMAND" | grep -q 'git push' || exit 0

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$PROJECT_DIR" || exit 0

ERRORS=""

# 1. Refuse --force to a protected branch.
if printf '%s' "$COMMAND" | grep -qE -- '--force\b|--force-with-lease\b|(^| )-f( |$)'; then
  for pb in $PROTECTED_BRANCHES; do
    if printf '%s' "$COMMAND" | grep -qE -- "\\b${pb}\\b"; then
      ERRORS="${ERRORS}\n- 'git push --force' to protected branch '${pb}' is forbidden without explicit approval."
      break
    fi
  done
fi

# 2. Refuse --no-verify.
if printf '%s' "$COMMAND" | grep -qE -- '--no-verify\b'; then
  ERRORS="${ERRORS}\n- 'git push --no-verify' is forbidden. Fix the underlying issue."
fi

# 3. Build + test — only when package.json declares the scripts.
if [ "${PUSH_SKIP_BUILD:-}" != "1" ] && [ -f package.json ] && command -v node >/dev/null 2>&1; then
  pm="npm"
  if [ -f pnpm-lock.yaml ] && command -v pnpm >/dev/null 2>&1; then pm="pnpm"
  elif [ -f yarn.lock ] && command -v yarn >/dev/null 2>&1; then pm="yarn"
  fi
  has_script() { node -e "process.exit(require('./package.json').scripts?.['$1']?0:1)" 2>/dev/null; }

  if has_script build; then
    echo "Push pre-flight: $pm run build..." >&2
    if ! $pm run build >&2 2>&1; then
      ERRORS="${ERRORS}\n- build FAILED (run: $pm run build)"
    fi
  fi
  if has_script test; then
    echo "Push pre-flight: $pm test..." >&2
    if ! CI=1 $pm test >&2 2>&1; then
      ERRORS="${ERRORS}\n- tests FAILED (run: $pm test)"
    fi
  fi
fi

# 4. Secret pattern in commits about to be pushed (vs upstream, else HEAD~1).
upstream=$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || echo "")
range=""
if [ -n "$upstream" ]; then range="${upstream}..HEAD"; fi
to_push=$(git diff ${range:-HEAD~1..HEAD} 2>/dev/null | grep '^+' | grep -v '^+++' || true)
if printf '%s\n' "$to_push" | grep -qE \
     'sk_live_[A-Za-z0-9]{8,}|sk-ant-[A-Za-z0-9_-]{8,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|xox[bap]-[A-Za-z0-9-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----' \
   || printf '%s\n' "$to_push" | grep -qiE \
     '(STRIPE_SECRET_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|GITHUB_TOKEN|AWS_SECRET_ACCESS_KEY)[[:space:]]*[:=][[:space:]]*["'"'"']?[A-Za-z0-9+/=_-]{16,}'; then
  ERRORS="${ERRORS}\n- Possible SECRET in commits about to be pushed. Rewrite history to remove it and rotate the value."
fi

# 5. Untracked source files imported by tracked code (would break a clean CI).
# shellcheck disable=SC2086
UNTRACKED=$(git ls-files --others --exclude-standard -- $SOURCE_GLOBS 2>/dev/null || true)
if [ -n "$UNTRACKED" ]; then
  MISSING=""
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    base=$(basename "$f" | sed -E 's/\.(ts|tsx|js|jsx|mjs|cjs)$//')
    dir=$(dirname "$f")
    # Imported by a sibling via a relative path?
    if git ls-files -- "$dir" 2>/dev/null \
         | xargs grep -lE "from ['\"]\\./${base}['\"]|require\\(['\"]\\./${base}['\"]\\)" 2>/dev/null \
         | head -1 >/dev/null 2>&1; then
      MISSING="${MISSING}\n  ${f}"
    fi
    # Re-exported from a tracked barrel (index)?
    for idx in index.ts index.tsx index.js; do
      if [ "$base" != "index" ] && [ -f "$dir/$idx" ] \
         && git ls-files --error-unmatch "$dir/$idx" >/dev/null 2>&1 \
         && grep -qE "from ['\"]\\./${base}['\"]" "$dir/$idx" 2>/dev/null; then
        MISSING="${MISSING}\n  ${f}"
      fi
    done
  done <<< "$UNTRACKED"
  MISSING=$(printf '%b' "$MISSING" | sort -u | grep -v '^$' || true)
  if [ -n "$MISSING" ]; then
    ERRORS="${ERRORS}\n- Untracked files imported by tracked code (will break CI):${MISSING}"
  fi
fi

if [ -n "$ERRORS" ]; then
  printf "Push pre-flight FAILED:%b\n" "$ERRORS" >&2
  exit 2
fi
exit 0
