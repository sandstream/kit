#!/usr/bin/env bash
# local-stack.sh — idempotent local dev bring-up: docker-up -> migrate -> seed -> env skeleton.
#
# Goal: one command takes a fresh clone to a running local stack, and re-running
# it is safe (no data loss, no duplicate seeds). Edit the marked sections for
# your stack. NEVER reset/drop a shared or prod database from here — destructive
# ops on shared data require explicit human sign-off (see kit's TOTP elevation).
#
# Usage: ./local-stack.sh
set -euo pipefail

cd "$(dirname "$0")"

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

# --- 1. Preconditions ---------------------------------------------------------
step "Checking prerequisites"
command -v docker >/dev/null 2>&1 || { echo "Docker not found. Install Docker and retry." >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "Docker daemon not running. Start Docker and retry." >&2; exit 1; }

# --- 2. Env skeleton (idempotent: only writes if absent) ----------------------
step "Ensuring local env file"
if [ ! -f .env.local ]; then
  if [ -f .env.example ]; then
    cp .env.example .env.local
    echo "Created .env.local from .env.example — fill in any blanks."
  else
    cat > .env.local <<'EOF'
# Local development env — fill in real values. Do NOT commit this file.
NODE_ENV=development
# DATABASE_URL=
# NEXT_PUBLIC_API_URL=http://localhost:3000
EOF
    echo "Created a starter .env.local — fill in real values."
  fi
else
  echo ".env.local already present — leaving it untouched."
fi

# --- 3. Bring up backing services (idempotent) --------------------------------
# Compose `up -d` is idempotent: existing healthy containers are left running.
step "Starting backing services"
# EDIT: replace with your stack's bring-up.
#   docker compose: docker compose up -d
#   supabase:       supabase start
docker compose up -d 2>/dev/null || echo "No docker-compose service to start (edit local-stack.sh)."

# --- 4. Apply migrations (forward-only; never reset) --------------------------
step "Applying migrations"
# EDIT: replace with your migration command. Use the FORWARD-only command.
#   supabase:  supabase migration up
#   prisma:    npx prisma migrate deploy
#   drizzle:   npx drizzle-kit migrate
echo "TODO: wire your forward-only migration command here."

# --- 5. Seed dev data (must be idempotent: upsert, not insert) ----------------
step "Seeding development data"
# EDIT: replace with your idempotent seed command.
#   npm run db:seed-dev
echo "TODO: wire your idempotent seed command here."

# --- 6. Verify required env --------------------------------------------------
if [ -x ./verify-env.sh ]; then
  step "Verifying environment"
  set -a; [ -f .env.local ] && . ./.env.local; set +a
  ./verify-env.sh || echo "WARN: some env keys are missing (see above)."
fi

step "Local stack ready"
echo "Start the app with your dev command (e.g. npm run dev)."
