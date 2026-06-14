#!/usr/bin/env bash
# install-pal-global.sh — activate PAL (Pending Action Ledger) globally.
#
# PAL is a single GLOBAL, append-only ledger of "blocked-on-you" action items
# that survives across sessions and repos, is surfaced at every SessionStart,
# and AUTO-CLOSES the moment an item's verify command starts passing — so
# handed-off tasks stop getting forgotten. Zero-LLM, local-first, deterministic.
#
# Two idempotent steps:
#   1. symlink the bundled engine into ~/.claude/hooks/pal
#   2. register the SessionStart surfacer in ~/.claude/settings.json
#      (backs up settings.json first; skips if already present)
#
# Run once per machine. A coding agent typically cannot self-register a
# SessionStart hook (its sandbox blocks self-modification of
# ~/.claude/settings.json) — so this is the human-run activation step.
#
# Engine resolution (first existing wins): $PAL_ENGINE, then the bundled
# scripts/pal shipped with kit (resolved relative to this script).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ENGINE="${PAL_ENGINE:-}"
if [ -z "$ENGINE" ]; then
  for cand in \
    "$HERE/../../scripts/pal" \
    "$HERE/../../../scripts/pal" \
    "$HERE/pal"; do
    if [ -f "$cand" ]; then ENGINE="$(cd "$(dirname "$cand")" && pwd)/$(basename "$cand")"; break; fi
  done
fi

HOOK="$HOME/.claude/hooks/pal"
SETTINGS="$HOME/.claude/settings.json"

[ -n "$ENGINE" ] && [ -f "$ENGINE" ] || { echo "engine not found — set PAL_ENGINE to the path of the bundled 'pal' script" >&2; exit 1; }
chmod +x "$ENGINE"
mkdir -p "$HOME/.claude/hooks"
ln -sf "$ENGINE" "$HOOK"
echo "OK symlink $HOOK -> $ENGINE"

CMD="python3 $HOOK surface"
python3 - "$SETTINGS" "$CMD" <<'PY'
import json, sys, os, shutil
settings, cmd = sys.argv[1], sys.argv[2]
if os.path.exists(settings):
    shutil.copy(settings, settings + ".bak")
    d = json.load(open(settings))
else:
    d = {}
ss = d.setdefault("hooks", {}).setdefault("SessionStart", [])
present = any(cmd in h.get("command", "") for g in ss for h in g.get("hooks", []))
if present:
    print("OK SessionStart hook already registered (idempotent, no change)")
else:
    ss.append({"hooks": [{"type": "command", "command": cmd}]})
    json.dump(d, open(settings, "w"), indent=2)
    print("OK registered PAL SessionStart hook in " + settings + " (backup: .bak)")
PY

echo ""
echo "PAL active — open items surface at every session start, in every repo."
echo "  list:   python3 $HOOK list"
echo "  close:  python3 $HOOK done <id>"
echo "  add:    python3 $HOOK add --owner user --repo R --title '...' --verify '<cmd that exits 0 when done>'"
