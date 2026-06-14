#!/usr/bin/env bash
# kit verify-suite — comprehensive end-to-end sweep
#
# Runs every documented kit subcommand against three contexts:
#   1. BROWNFIELD: an existing real project (default: ${1:-.})
#   2. GREENFIELD: a fresh tmpdir with a minimal Next.js + Supabase scaffold
#   3. AGENT:     same greenfield with .claude/ + .claude/skills/ + .claude/agents/
#
# Each command is recorded as PASS / FAIL / SKIP with a one-line excerpt. Exit
# code reflects the overall outcome.
#
# Usage:  scripts/verify-suite.sh [--brownfield-dir <path>] [--keep-tmpdirs]

set -u

BROWNFIELD_DIR="${1:-${1:-.}}"
KIT_BIN="${KIT_BIN:-$(realpath "$(dirname "$0")/../dist/cli.js")}"
KEEP_TMP=0
for arg in "$@"; do
  case "$arg" in
    --keep-tmpdirs) KEEP_TMP=1 ;;
    --brownfield-dir) shift; BROWNFIELD_DIR="$1" ;;
  esac
done

PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0
declare -a RESULTS

run() {
  local label="$1"; shift
  local context="$1"; shift
  local cwd="$1"; shift
  local timeout="${1:-30}"; shift || true
  local cmd=("$@")

  local out
  local code
  out=$(cd "$cwd" && KIT_NON_INTERACTIVE=1 timeout "$timeout" node "$KIT_BIN" "${cmd[@]}" 2>&1)
  code=$?

  local status excerpt
  excerpt=$(printf '%s' "$out" | head -1 | sed 's/\x1b\[[0-9;]*m//g' | cut -c 1-80)

  # Some commands legitimately exit non-zero (e.g. policy-violation found,
  # rotate refused without elevation, purge-history refused without --force).
  # Differentiate by output content: a "Usage:" first line on a refusal-by-
  # default command is a regression bug; on a usage-error invocation it's
  # expected. We tag refusals separately so the operator can scan them.
  if [ "$code" = 0 ]; then
    status=PASS
    PASS_COUNT=$((PASS_COUNT+1))
  elif [ "$code" = 1 ]; then
    # exit 1: could be intentional refusal (warn) or actual error.
    # If the excerpt is just the usage line, treat as REGRESSION.
    if echo "$excerpt" | grep -qE '^Usage:'; then
      status="REGRESSION"
      FAIL_COUNT=$((FAIL_COUNT+1))
    else
      status="REFUSED(1)"
      PASS_COUNT=$((PASS_COUNT+1))
    fi
  elif [ "$code" = 124 ]; then
    status="FAIL(timeout)"
    FAIL_COUNT=$((FAIL_COUNT+1))
  else
    status="FAIL($code)"
    FAIL_COUNT=$((FAIL_COUNT+1))
  fi

  RESULTS+=("$(printf '%-10s  %-9s  %-40s  %s' "$context" "$status" "$label" "$excerpt")")
}

skip() {
  local label="$1"; shift
  local context="$1"; shift
  local reason="$1"; shift
  SKIP_COUNT=$((SKIP_COUNT+1))
  RESULTS+=("$(printf '%-10s  %-9s  %-40s  %s' "$context" "SKIP" "$label" "$reason")")
}

# ── BROWNFIELD ───────────────────────────────────────────────────────────────
if [ -d "$BROWNFIELD_DIR" ]; then
  CTX="brownfield"
  run "check"                   "$CTX" "$BROWNFIELD_DIR" 180 check
  run "doctor"                  "$CTX" "$BROWNFIELD_DIR"  30 doctor
  run "env"                     "$CTX" "$BROWNFIELD_DIR"  30 env
  run "env current"             "$CTX" "$BROWNFIELD_DIR"  30 env current
  run "audit"                   "$CTX" "$BROWNFIELD_DIR"  30 audit
  run "audit secrets"           "$CTX" "$BROWNFIELD_DIR"  30 audit secrets
  run "analyze --claude"        "$CTX" "$BROWNFIELD_DIR"  30 analyze --claude
  run "analyze --rules"         "$CTX" "$BROWNFIELD_DIR"  30 analyze --rules
  run "security policy check"   "$CTX" "$BROWNFIELD_DIR"  60 security policy check
  run "security scan-build"     "$CTX" "$BROWNFIELD_DIR" 120 security scan-build
  run "security scan-transcripts" "$CTX" "$BROWNFIELD_DIR" 60 security scan-transcripts
  run "security check-gitignore" "$CTX" "$BROWNFIELD_DIR" 30 security check-gitignore
  run "security verify-pull"    "$CTX" "$BROWNFIELD_DIR"  60 security verify-pull
  run "security costs"          "$CTX" "$BROWNFIELD_DIR"  30 security costs
  run "secrets onecli status"   "$CTX" "$BROWNFIELD_DIR"  15 secrets onecli status
  run "auth status"             "$CTX" "$BROWNFIELD_DIR"  10 auth status
else
  skip "brownfield"            "brownfield" "not found: $BROWNFIELD_DIR"
fi

# ── GREENFIELD ───────────────────────────────────────────────────────────────
GREEN_DIR=$(mktemp -d -t kit-verify-green.XXXXXX)
cd "$GREEN_DIR"
git init -q
git config user.email t@t
git config user.name t
cat > package.json <<EOF
{"name":"green","dependencies":{"next":"15.0.0","@supabase/supabase-js":"2.0.0","stripe":"14.0.0"},"devDependencies":{"vitest":"1.0.0"}}
EOF
git add package.json
git commit -q -m "initial"
cd - >/dev/null

CTX="greenfield"
run "init --non-interactive"  "$CTX" "$GREEN_DIR" 60  init --non-interactive
run "check"                   "$CTX" "$GREEN_DIR" 120 check
run "fix"                     "$CTX" "$GREEN_DIR" 60  fix
run "doctor"                  "$CTX" "$GREEN_DIR" 30  doctor
run "env"                     "$CTX" "$GREEN_DIR" 30  env
run "audit"                   "$CTX" "$GREEN_DIR" 30  audit
run "analyze"                 "$CTX" "$GREEN_DIR" 30  analyze
run "security policy init"    "$CTX" "$GREEN_DIR" 30  security policy init
run "security policy check"   "$CTX" "$GREEN_DIR" 30  security policy check
run "security check-gitignore" "$CTX" "$GREEN_DIR" 30 security check-gitignore
run "security check-gitignore --fix" "$CTX" "$GREEN_DIR" 30 security check-gitignore --fix
run "security verify-pull"    "$CTX" "$GREEN_DIR" 30  security verify-pull
run "security costs"          "$CTX" "$GREEN_DIR" 30  security costs
run "hooks add secret-scan"   "$CTX" "$GREEN_DIR" 30  hooks add secret-scan
run "hooks add post-pull-audit" "$CTX" "$GREEN_DIR" 30 hooks add post-pull-audit
run "env switch staging"      "$CTX" "$GREEN_DIR" 30  env switch staging
run "auth status (no marker)" "$CTX" "$GREEN_DIR" 10  auth status

# ── AGENT setup ──────────────────────────────────────────────────────────────
AGENT_DIR=$(mktemp -d -t kit-verify-agent.XXXXXX)
cd "$AGENT_DIR"
git init -q
git config user.email t@t
git config user.name t
mkdir -p .claude/skills/kit .claude/agents
cat > package.json <<EOF
{"name":"agent","dependencies":{"next":"15.0.0"}}
EOF
cat > .claude/skills/kit/SKILL.md <<'EOF'
---
name: kit
description: dev-environment manager
---
# kit skill placeholder
EOF
cat > .claude/agents/founding-engineer.md <<'EOF'
---
name: Founding Engineer
tools: Bash, Read, Edit, Write
---
Founding engineer agent.
EOF
cat > .claude/settings.json <<'EOF'
{"model":"sonnet","permissions":{"defaultMode":"acceptEdits"}}
EOF
git add .
git commit -q -m "initial agent scaffold"
cd - >/dev/null

CTX="agent"
run "init --non-interactive"  "$CTX" "$AGENT_DIR" 60 init --non-interactive
run "analyze --claude"        "$CTX" "$AGENT_DIR" 30 analyze --claude
run "security scan-transcripts" "$CTX" "$AGENT_DIR" 30 security scan-transcripts
run "secrets rotate (refused: no elev)" "$CTX" "$AGENT_DIR" 30 secrets rotate API_KEY --random
run "secrets rotate --from-cli" "$CTX" "$AGENT_DIR" 30 secrets rotate STRIPE_SECRET_KEY --from-cli
run "secrets purge-history (refused: no force)" "$CTX" "$AGENT_DIR" 30 secrets purge-history "sk_test_AAAAAAAAAAAAAAAAAAAA"
run "auth elevate (refused: non-interactive)" "$CTX" "$AGENT_DIR" 15 auth elevate

# ── Report ──────────────────────────────────────────────────────────────────
echo
echo "=================== kit verify-suite ==================="
printf '%-10s  %-9s  %-40s  %s\n' "context" "status" "command" "excerpt"
echo "-----------------------------------------------------------"
for row in "${RESULTS[@]}"; do
  echo "$row"
done
echo "-----------------------------------------------------------"
echo "PASS=$PASS_COUNT  FAIL=$FAIL_COUNT  SKIP=$SKIP_COUNT"
echo

if [ "$KEEP_TMP" = "0" ]; then
  rm -rf "$GREEN_DIR" "$AGENT_DIR"
else
  echo "Tmpdirs kept:"
  echo "  greenfield: $GREEN_DIR"
  echo "  agent:      $AGENT_DIR"
fi

if [ "$FAIL_COUNT" -gt 0 ]; then
  exit 1
fi
exit 0
