#!/usr/bin/env bash
# sanity-preflight.sh — START-gate (Claude Code: UserPromptSubmit).
#
# Fast sanity + security check BEFORE the agent acts on each prompt.
# SILENT when clean; injects a short warning only on a real problem, and
# DEDUPLICATES via a marker file so the same state is not re-spammed prompt
# after prompt. FAIL-OPEN (always exit 0) — advisory, never blocks.
#
# Detects:
#   1. Likely secrets in the working diff (tight pattern, low false-positive).
#   2. Uncommitted changes on a protected branch (branch-first convention).
#
# Portable: no project-specific assumptions. Reads marker dir from
# SANITY_MARKER_DIR (default .git/.kit). Protected branches from
# PROTECTED_BRANCHES (default "main master").
set -euo pipefail

root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
cd "$root" || exit 0

PROTECTED_BRANCHES="${PROTECTED_BRANCHES:-main master}"
marker_dir="${SANITY_MARKER_DIR:-.git/.kit}"
mkdir -p "$marker_dir" 2>/dev/null || true

warn=""

# --- 1. Secrets in diff ---------------------------------------------------
# Two signals, both tight enough for low false-positives:
#   (a) provider-prefixed tokens (live keys, vendor tokens, PEM headers)
#   (b) named env keys assigned a 16+ char value
diff=$(git diff HEAD 2>/dev/null | grep '^+' | grep -v '^+++' || true)

prefixed=$(printf '%s\n' "$diff" | grep -nE \
  'sk_live_[A-Za-z0-9]{8,}|sk-ant-[A-Za-z0-9_-]{8,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|xox[bap]-[A-Za-z0-9-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----' \
  | head -2 || true)

named=$(printf '%s\n' "$diff" | grep -niE \
  '(STRIPE_SECRET_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|GITHUB_TOKEN|AWS_SECRET_ACCESS_KEY)[[:space:]]*[:=][[:space:]]*["'"'"']?[A-Za-z0-9+/=_-]{16,}' \
  | head -2 || true)

if [ -n "$prefixed" ] || [ -n "$named" ]; then
  warn="${warn}WARNING: possible SECRET in working diff — do NOT commit until verified / moved to a secret store.\n"
fi

# --- 2. Uncommitted changes on a protected branch -------------------------
# Deduplicated per change-set hash so it shows once per distinct state.
branch=$(git branch --show-current 2>/dev/null || echo "")
for pb in $PROTECTED_BRANCHES; do
  if [ "$branch" = "$pb" ]; then
    porcelain=$(git status --porcelain 2>/dev/null || true)
    if [ -n "$porcelain" ]; then
      st=$(printf '%s' "$porcelain" | (shasum 2>/dev/null || sha1sum 2>/dev/null) | cut -d' ' -f1)
      marker="${marker_dir}/sanity-branch-${st}"
      if [ ! -f "$marker" ]; then
        n=$(printf '%s\n' "$porcelain" | grep -c . || echo "?")
        warn="${warn}WARNING: ${n} uncommitted change(s) on protected branch '${branch}'. Create a feature branch before committing.\n"
        rm -f "${marker_dir}"/sanity-branch-* 2>/dev/null || true
        touch "$marker" 2>/dev/null || true
      fi
    fi
    break
  fi
done

# Silent when nothing to flag.
[ -z "$warn" ] && exit 0
printf "SANITY-PREFLIGHT (START-gate):\n%b" "$warn"
exit 0
