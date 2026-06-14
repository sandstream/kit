#!/usr/bin/env bash
# stop-review-gate.sh — END-gate (Claude Code: Stop hook).
#
# Forces a review of UNTOUCHED feature-zone changes before the agent is
# allowed to finish. Verification happens BEFORE the agent declares done,
# not after.
#
# Loop-guard (two layers):
#   (1) stop_hook_active=true  → release (already inside a block-chain).
#   (2) marker file per change-set hash → release (already reviewed).
#
# Configure FEATURE_ZONES below (or via env). Defaults are cross-stack:
# common source roots + migrations. Output is a harness `block` decision
# (stdout JSON) instructing the agent to review the changed files.
set -euo pipefail

# Cross-stack defaults — override by exporting FEATURE_ZONES (space-separated
# path prefixes, relative to repo root).
FEATURE_ZONES="${FEATURE_ZONES:-src/ app/ lib/ components/ packages/ migrations/}"

marker_dir="${REVIEW_MARKER_DIR:-.git/.kit}"

input=$(cat 2>/dev/null || echo '{}')

# (1) Loop-guard: if this Stop already follows a hook block → release.
active=$(printf '%s' "$input" | python3 -c "import sys,json
try: print(str(json.load(sys.stdin).get('stop_hook_active', False)))
except Exception: print('False')" 2>/dev/null || echo False)
[ "$active" = "True" ] && exit 0

root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
cd "$root" || exit 0
mkdir -p "$marker_dir" 2>/dev/null || true

# Build an alternation regex from FEATURE_ZONES: matches a porcelain line
# whose path begins with any configured zone prefix.
zone_re=""
for z in $FEATURE_ZONES; do
  esc=$(printf '%s' "$z" | sed 's/[.[\*^$()+?{|]/\\&/g')
  zone_re="${zone_re}${zone_re:+|}${esc}"
done
[ -z "$zone_re" ] && exit 0

# Untracked + unstaged + staged (not committed) changes inside feature zones.
changed=$(git status --porcelain 2>/dev/null \
  | grep -E "^.{1,2} (${zone_re})" \
  || true)
[ -z "$changed" ] && exit 0   # no feature changes → release

# Marker per exact change-set → already reviewed?
hash=$(printf '%s' "$changed" | (shasum 2>/dev/null || sha1sum 2>/dev/null) | cut -d' ' -f1)
marker="${marker_dir}/reviewed-${hash}"
[ -f "$marker" ] && exit 0     # already reviewed → release

# Otherwise: block + instruct the agent to review before finishing.
REASON="Feature zone changed but not reviewed. Review BEFORE you finish:
1. Re-read the changed files against these lenses: correctness/business-logic, UX consistency, project conventions, and security (run 'kit check --category security' if kit is installed).
2. Run the relevant test or end-to-end spec if a UI or behavioural flow changed.
3. Fix any blocker/high finding, or consciously acknowledge it in one line to the user.
4. Release the gate: touch \"${marker}\"

Changed feature files:
${changed}"

python3 -c "import json,sys
print(json.dumps({'decision':'block','reason':sys.argv[1]}))" "$REASON"
exit 0
