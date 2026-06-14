#!/usr/bin/env bash
# verify-env.sh — fail fast on missing required env keys.
#
# Run before `dev`, `build`, or `deploy` so a missing key fails loudly here
# instead of as a cryptic runtime error later. Reports *all* missing keys at
# once, not just the first. Checks presence only — it never prints values.
#
# Usage:
#   ./verify-env.sh                 # check the keys listed below
#   ./verify-env.sh KEY_A KEY_B     # check the keys you pass instead
#   source .env.local && ./verify-env.sh   # check what's in a dotenv file
set -euo pipefail

# --- Required keys: edit this list for your project ---------------------------
REQUIRED_DEFAULT=(
  DATABASE_URL
  # NEXT_PUBLIC_API_URL
  # AUTH_SECRET
)

# Keys required only outside local dev (e.g. live payment/email providers).
REQUIRED_PROD=(
  # PAYMENT_API_KEY
  # EMAIL_API_KEY
)
# -----------------------------------------------------------------------------

REQUIRED=("$@")
if [ ${#REQUIRED[@]} -eq 0 ]; then
  REQUIRED=("${REQUIRED_DEFAULT[@]}")
  if [ "${NODE_ENV:-development}" = "production" ]; then
    REQUIRED+=("${REQUIRED_PROD[@]}")
  fi
fi

missing=()
for key in "${REQUIRED[@]}"; do
  # Missing OR empty both count as not set.
  if [ -z "${!key:-}" ]; then
    missing+=("$key")
  fi
done

if [ ${#missing[@]} -gt 0 ]; then
  echo "ERROR: missing required environment variables:" >&2
  for key in "${missing[@]}"; do
    echo "  - $key" >&2
  done
  echo "" >&2
  echo "Set them in your environment or .env file. See .env.example." >&2
  exit 1
fi

echo "env OK — ${#REQUIRED[@]} required key(s) present."
