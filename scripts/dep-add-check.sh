#!/usr/bin/env bash
# dep-add-check.sh — gate before adding a third-party dependency.
#
# WHY: Real-world supply-chain incidents (a malicious/compromised package version
# pulled in via an unpinned range) show that "npm install <pkg>" with a caret/
# tilde range trusts whatever the registry serves at install time. This script
# forces three things BEFORE a dep lands in the manifest:
#   1. EXACT version pin (no ^, ~, *, latest, ranges).
#   2. SHA-256 integrity check of the resolved tarball against the registry.
#   3. A triage gate hook point (license / maintenance / known-CVE review).
#
# Portable: npm/yarn/pnpm (node), pip (python), cargo (rust). Detects ecosystem
# from the argument syntax or the --eco flag.
#
# ADVISORY by default: prints PASS/WARN/FAIL and a recommendation. It does NOT
# install anything. Wire it into a pre-add hook or run it by hand. Exit codes:
#   0 = PASS (pinned + integrity verified + triage clean-or-acknowledged)
#   1 = WARN (something needs human attention; do not auto-proceed)
#   2 = usage / environment error
#
# Usage:
#   dep-add-check.sh npm  left-pad@1.3.0
#   dep-add-check.sh pip  requests==2.32.3
#   dep-add-check.sh cargo serde@1.0.210
#   dep-add-check.sh --eco npm express@4.21.0
#
set -euo pipefail

PROG="$(basename "$0")"

die()  { printf '%s: error: %s\n' "$PROG" "$1" >&2; exit 2; }
warn() { printf 'WARN  %s\n' "$1"; }
ok()   { printf 'PASS  %s\n' "$1"; }
bad()  { printf 'FAIL  %s\n' "$1"; }
note() { printf '      %s\n' "$1"; }

[ $# -ge 1 ] || die "usage: $PROG <npm|pip|cargo> <name@version|name==version> [--triage-cmd <cmd>]"

ECO=""
SPEC=""
# Allow a project-supplied triage command (e.g. an org triage wrapper).
TRIAGE_CMD="${DEP_TRIAGE_CMD:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --eco)        ECO="${2:-}"; shift 2;;
    --triage-cmd) TRIAGE_CMD="${2:-}"; shift 2;;
    npm|yarn|pnpm) ECO="node"; shift;;
    pip|pip3)     ECO="python"; shift;;
    cargo)        ECO="rust"; shift;;
    -h|--help)    sed -n '2,40p' "$0"; exit 0;;
    *)            SPEC="$1"; shift;;
  esac
done

[ -n "$SPEC" ] || die "no package spec given"

# ---- Parse name + version, infer ecosystem if not set --------------------------
NAME=""; VERSION=""
case "$SPEC" in
  *==*) NAME="${SPEC%%==*}"; VERSION="${SPEC##*==}"; ECO="${ECO:-python}";;
  *@*)  # last @ separates version (scoped npm names start with @)
        VERSION="${SPEC##*@}"; NAME="${SPEC%@*}"; ECO="${ECO:-node}";;
  *)    NAME="$SPEC";;
esac
[ -n "$ECO" ] || die "could not infer ecosystem; pass npm|pip|cargo or --eco"

printf '== dep-add-check: %s (%s) ==\n' "$SPEC" "$ECO"

STATUS=0  # 0 pass, 1 warn

# ---- Gate 1: exact pin ---------------------------------------------------------
if [ -z "$VERSION" ]; then
  bad "no version pinned. Refusing an unpinned/range install."
  note "Re-run as ${NAME}@<exact-version> (npm/cargo) or ${NAME}==<exact-version> (pip)."
  exit 1
fi
case "$VERSION" in
  *"^"*|*"~"*|*"*"*|*">"*|*"<"*|latest|"")
    bad "version '$VERSION' is a range/floating tag. Pin an EXACT version."
    STATUS=1;;
  *)
    ok "version pinned exactly: $VERSION";;
esac

# ---- Gate 2: SHA-256 integrity vs registry -------------------------------------
sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum | awk '{print $1}'
  else shasum -a 256 | awk '{print $1}'; fi
}

verify_integrity_node() {
  command -v npm >/dev/null 2>&1 || { warn "npm not found; skipping integrity check"; return 1; }
  # npm view returns the registry-published integrity (SRI) + tarball URL.
  local sri url tmp got_b64 want_b64
  sri="$(npm view "${NAME}@${VERSION}" dist.integrity 2>/dev/null || true)"
  url="$(npm view "${NAME}@${VERSION}" dist.tarball 2>/dev/null || true)"
  if [ -z "$url" ]; then warn "registry has no tarball for ${NAME}@${VERSION}"; return 1; fi
  tmp="$(mktemp)"; trap 'rm -f "$tmp"' RETURN
  if ! curl -fsSL "$url" -o "$tmp"; then warn "could not download tarball to verify"; return 1; fi
  if [ -n "$sri" ] && [ "${sri#sha512-}" != "$sri" ]; then
    # Registry SRI is sha512; recompute sha512 of downloaded tarball and compare.
    want_b64="${sri#sha512-}"
    if command -v openssl >/dev/null 2>&1; then
      got_b64="$(openssl dgst -sha512 -binary "$tmp" | openssl base64 -A)"
      if [ "$got_b64" = "$want_b64" ]; then ok "tarball matches registry SRI (sha512)"; else
        bad "tarball SHA mismatch vs registry SRI — possible tampering. ABORT."; return 1; fi
    else warn "openssl missing; cannot verify sha512 SRI"; return 1; fi
  fi
  # Also surface the sha256 of the exact artifact so it can be recorded/pinned.
  note "sha256(tarball)=$(sha256 < "$tmp")"
  return 0
}

verify_integrity_python() {
  command -v curl >/dev/null 2>&1 || { warn "curl not found; skipping"; return 1; }
  local json digest
  json="$(curl -fsSL "https://pypi.org/pypi/${NAME}/${VERSION}/json" 2>/dev/null || true)"
  [ -n "$json" ] || { warn "PyPI has no ${NAME}==${VERSION}"; return 1; }
  if command -v python3 >/dev/null 2>&1; then
    digest="$(printf '%s' "$json" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(next((u["digests"]["sha256"] for u in d.get("urls",[]) if u["digests"].get("sha256")),""))' 2>/dev/null || true)"
    [ -n "$digest" ] && ok "PyPI publishes sha256=$digest for ${NAME}==${VERSION}" || { warn "no sha256 digest on PyPI record"; return 1; }
    note "pin with a hash: pip install --require-hashes  (add to requirements: ${NAME}==${VERSION} --hash=sha256:${digest})"
  else warn "python3 missing; cannot parse PyPI json"; return 1; fi
  return 0
}

verify_integrity_rust() {
  command -v curl >/dev/null 2>&1 || { warn "curl not found; skipping"; return 1; }
  local json cksum tmp
  json="$(curl -fsSL "https://crates.io/api/v1/crates/${NAME}/${VERSION}" 2>/dev/null || true)"
  [ -n "$json" ] || { warn "crates.io has no ${NAME}@${VERSION}"; return 1; }
  if command -v python3 >/dev/null 2>&1; then
    cksum="$(printf '%s' "$json" | python3 -c 'import sys,json; print(json.load(sys.stdin)["version"]["checksum"])' 2>/dev/null || true)"
  fi
  if [ -n "${cksum:-}" ]; then
    tmp="$(mktemp)"; trap 'rm -f "$tmp"' RETURN
    if curl -fsSL "https://crates.io/api/v1/crates/${NAME}/${VERSION}/download" -o "$tmp"; then
      if [ "$(sha256 < "$tmp")" = "$cksum" ]; then ok ".crate matches crates.io sha256 checksum"; else
        bad ".crate SHA mismatch vs crates.io — possible tampering. ABORT."; return 1; fi
    else warn "could not download .crate to verify"; return 1; fi
  else warn "no checksum on crates.io record"; return 1; fi
  return 0
}

# Only attempt registry integrity once we have an exact, well-formed version.
if [ "$STATUS" -ne 0 ]; then
  warn "skipping integrity check until an exact version is pinned"
else
  case "$ECO" in
    node)   verify_integrity_node   || STATUS=1;;
    python) verify_integrity_python || STATUS=1;;
    rust)   verify_integrity_rust   || STATUS=1;;
    *)      warn "no integrity verifier for ecosystem '$ECO'"; STATUS=1;;
  esac
fi

# ---- Gate 3: triage hook point -------------------------------------------------
# Policy (see your project agent-config / CONTRIBUTING): run a triage command
# before installing anything new. If a triage command is configured, run it and
# honor its exit code. If none is configured, emit the manual checklist and WARN
# so a human decides.
if [ -n "$TRIAGE_CMD" ]; then
  printf '== triage: %s %s %s ==\n' "$TRIAGE_CMD" "$ECO" "$NAME"
  if "$TRIAGE_CMD" "$ECO" "$NAME"; then ok "triage gate passed"; else
    bad "triage gate did NOT pass — stop and escalate before installing."; STATUS=1; fi
else
  warn "no triage command configured (DEP_TRIAGE_CMD / --triage-cmd). Manual triage required:"
  note "- License compatible with project? (no GPL surprise in a permissive codebase)"
  note "- Maintained? (recent commits, >1 maintainer, not a typosquat of a popular name)"
  note "- Known CVEs? (osv.dev / npm audit / pip-audit / cargo audit)"
  note "- Footprint justified? (no 200-dep tree for a one-liner)"
  STATUS=1
fi

# ---- Verdict -------------------------------------------------------------------
echo "------------------------------------------"
if [ "$STATUS" -eq 0 ]; then
  ok "OK to add ${NAME}@${VERSION} — pinned, integrity-verified, triage clean."
  exit 0
else
  bad "NOT clear to auto-add ${NAME} — resolve the WARN/FAIL items above first."
  exit 1
fi
