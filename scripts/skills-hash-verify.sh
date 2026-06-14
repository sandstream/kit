#!/usr/bin/env bash
# skills-hash-verify.sh — verify installed skills against skills-lock.json (SHA-256).
#
# WHY: Skills are executable instructions an agent will follow. A silently
# modified or swapped skill is a supply-chain risk equivalent to a tampered
# dependency. skills-lock.json pins a SHA-256 per skill; this script recomputes
# the hash of each skill directory and compares. Drift => investigate before use.
#
# Lock format (see templates/skills-lock.json):
#   { "version": 1, "skills": { "<name>": { "source": "...",
#       "sourceType": "well-known|vendored|local", "computedHash": "<sha256>" } } }
#
# Canonical hash = SHA-256 over the sorted list of "<relpath>\n<sha256(file)>\n"
# for every regular file under the skill dir (deterministic across machines).
#
# Modes:
#   verify (default) — compare each locked skill's current hash to the lock; report drift.
#   update           — recompute and rewrite computedHash for all skills (use after an
#                      intentional change; review the diff before committing).
#
# ADVISORY exit codes:
#   0 = all locked skills match
#   1 = drift detected (hash mismatch, missing dir, or unlocked skill present)
#   2 = usage / environment error
#
# Usage:
#   skills-hash-verify.sh [--lock <path>] [--skills-dir <dir>] [verify|update]
# Defaults: --lock ./skills-lock.json  --skills-dir ./.agents/skills (fallback .claude/skills)
#
set -euo pipefail

PROG="$(basename "$0")"
LOCK="./skills-lock.json"
SKILLS_DIR=""
MODE="verify"

die() { printf '%s: error: %s\n' "$PROG" "$1" >&2; exit 2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --lock)       LOCK="${2:?}"; shift 2;;
    --skills-dir) SKILLS_DIR="${2:?}"; shift 2;;
    verify|update) MODE="$1"; shift;;
    -h|--help)    sed -n '2,32p' "$0"; exit 0;;
    *)            die "unknown arg: $1";;
  esac
done

# Default skills dir: prefer .agents/skills (source of truth), else .claude/skills.
if [ -z "$SKILLS_DIR" ]; then
  if   [ -d "./.agents/skills" ]; then SKILLS_DIR="./.agents/skills"
  elif [ -d "./.claude/skills" ]; then SKILLS_DIR="./.claude/skills"
  else die "no skills dir found (.agents/skills or .claude/skills); pass --skills-dir"; fi
fi
command -v python3 >/dev/null 2>&1 || die "python3 required (json parse/edit)"
# verify needs an existing lock; update may create one from scratch.
if [ "$MODE" = "verify" ] && [ ! -f "$LOCK" ]; then die "lock file not found: $LOCK"; fi
if [ ! -f "$LOCK" ]; then printf '{\n  "version": 1,\n  "skills": {}\n}\n' > "$LOCK"; fi

# ---- portable per-file sha256 --------------------------------------------------
file_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}

# ---- canonical hash of a skill directory --------------------------------------
# Follows symlinks (skills are often symlinked from .agents into .claude).
# Excludes VCS/OS noise so the hash reflects skill content only.
skill_dir_hash() {
  local dir="$1" rel f h
  local manifest; manifest="$(mktemp)"
  while IFS= read -r f; do
    rel="${f#"$dir"/}"
    h="$(file_sha256 "$f")"
    printf '%s\n%s\n' "$rel" "$h" >> "$manifest"
  done < <(find -L "$dir" -type f \
              ! -path '*/.git/*' ! -name '.DS_Store' ! -name 'Thumbs.db' \
              | LC_ALL=C sort)
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$manifest" | awk '{print $1}'
  else shasum -a 256 "$manifest" | awk '{print $1}'; fi
  rm -f "$manifest"
}

# ---- list skill names from the lock -------------------------------------------
locked_skills() {
  python3 -c 'import json,sys; print("\n".join(json.load(open(sys.argv[1])).get("skills",{}).keys()))' "$LOCK"
}

DRIFT=0

if [ "$MODE" = "verify" ]; then
  printf '== skills-hash-verify (%s) ==\n' "$SKILLS_DIR"
  # 1) every locked skill must exist and match
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    want="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["skills"][sys.argv[2]].get("computedHash",""))' "$LOCK" "$name")"
    sdir="$SKILLS_DIR/$name"
    if [ ! -d "$sdir" ]; then printf 'MISSING  %-32s (locked but no directory)\n' "$name"; DRIFT=1; continue; fi
    got="$(skill_dir_hash "$sdir")"
    if [ "$got" = "$want" ]; then printf 'OK       %-32s %s\n' "$name" "${got:0:12}…"
    else printf 'DRIFT    %-32s want %s got %s\n' "$name" "${want:0:12}…" "${got:0:12}…"; DRIFT=1; fi
  done < <(locked_skills)

  # 2) flag installed skills that are NOT in the lock (unpinned = unreviewed)
  while IFS= read -r d; do
    [ -d "$d" ] || continue
    n="$(basename "$d")"
    if ! locked_skills | grep -qxF "$n"; then printf 'UNLOCKED %-32s (present but not in lock)\n' "$n"; DRIFT=1; fi
  done < <(find -L "$SKILLS_DIR" -mindepth 1 -maxdepth 1 -type d | LC_ALL=C sort)

  echo "------------------------------------------"
  if [ "$DRIFT" -eq 0 ]; then echo "PASS  all locked skills match"; exit 0
  else echo "FAIL  skill drift detected — review changes, then run '$PROG update' if intentional"; exit 1; fi

elif [ "$MODE" = "update" ]; then
  printf '== skills-hash-verify update (%s) ==\n' "$SKILLS_DIR"
  TMP="$(mktemp)"
  # Build name=hash pairs for every skill dir present, then merge into the lock.
  PAIRS="$(mktemp)"
  while IFS= read -r d; do
    [ -d "$d" ] || continue
    n="$(basename "$d")"
    printf '%s\t%s\n' "$n" "$(skill_dir_hash "$d")" >> "$PAIRS"
  done < <(find -L "$SKILLS_DIR" -mindepth 1 -maxdepth 1 -type d | LC_ALL=C sort)

  python3 - "$LOCK" "$PAIRS" > "$TMP" <<'PY'
import json, sys
lock_path, pairs_path = sys.argv[1], sys.argv[2]
lock = json.load(open(lock_path))
lock.setdefault("version", 1)
skills = lock.setdefault("skills", {})
for line in open(pairs_path):
    name, h = line.rstrip("\n").split("\t", 1)
    entry = skills.setdefault(name, {"source": "local", "sourceType": "local"})
    entry["computedHash"] = h
print(json.dumps(lock, indent=2, ensure_ascii=False))
PY
  mv "$TMP" "$LOCK"; rm -f "$PAIRS"
  echo "PASS  lock updated: $LOCK (review the diff before committing)"
  exit 0
fi
