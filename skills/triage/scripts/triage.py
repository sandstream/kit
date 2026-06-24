#!/usr/bin/env python3
"""kit triage — deterministic, zero-LLM pre-install security evaluation.

Usage:
    triage.py <type> <target>
    type: npm | pip | repo | docker | skill | tools | all

kit (src/triage.ts) shells to this script and reads its STDOUT:
  - the line "TRIAGE PASSED" must be present for kit to treat the target as safe;
  - "Health score: N/100", "Critical issues: N", "Warnings: N" are parsed for the
    structured summary.

Design contract (matches kit's watertight gate):
  - Deterministic. No LLM, no randomness. Same input + same upstream state => same verdict.
  - Dependency-light. Python stdlib only (urllib), so the skill is portable.
  - Fail-closed. If a registry cannot be reached (offline, timeout, error), that is a
    CRITICAL ("cannot verify") and "TRIAGE PASSED" is withheld, so kit blocks the install.
  - PASS rule: "TRIAGE PASSED" is printed when there are zero CRITICAL issues. Warnings
    are surfaced and scored but do not, by themselves, withhold PASS (criticals do).

Exit code is always 0 on a completed evaluation; kit reads the text, not the code.
"""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

TIMEOUT = 15
UA = {"User-Agent": "kit-triage/1.0 (+https://github.com/sandstream/kit)"}
NEW_DAYS = 30          # younger than this => warning (insufficient track record)
ABANDONED_DAYS = 730   # no release/push in this long => warning

# Registry endpoints — overridable so an AIR-GAPPED / no-egress environment can
# point triage at INTERNAL MIRRORS instead of the public hosts. These are set by
# the operator (trusted env), default to the public registries, and have any
# trailing slash trimmed. See docs/AIR_GAP.md.
NPM_REGISTRY = os.environ.get("KIT_NPM_REGISTRY", "https://registry.npmjs.org").rstrip("/")
PYPI_INDEX = os.environ.get("KIT_PYPI_INDEX", "https://pypi.org").rstrip("/")
GITHUB_API = os.environ.get("KIT_GITHUB_API", "https://api.github.com").rstrip("/")
DOCKER_REGISTRY = os.environ.get("KIT_DOCKER_REGISTRY", "https://hub.docker.com").rstrip("/")


def _get_json(url, headers=None):
    h = dict(UA)
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, headers=h)
    # The URL is intentionally dynamic: a registry-triage tool MUST fetch the
    # target's page. SSRF is not reachable here -- the host comes from an
    # operator-set registry constant (public registry by default, or an internal
    # mirror via KIT_*_REGISTRY/INDEX/API env) and only the package/repo name is
    # interpolated into the PATH (url-quoted for npm/pip, parsed to owner/repo for
    # GitHub). The attacker controls the path, never the host. Reviewed false positive.
    # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return json.load(r), r.status


def _days_since(iso):
    """Days since an ISO-8601 timestamp, or None if unparseable."""
    if not iso:
        return None
    try:
        s = iso.replace("Z", "+00:00")
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return (datetime.now(timezone.utc) - dt).days
    except ValueError:
        return None


class Report:
    def __init__(self, ttype, target):
        self.ttype = ttype
        self.target = target
        self.criticals = []
        self.warnings = []
        self.facts = []

    def critical(self, m):
        self.criticals.append(m)

    def warn(self, m):
        self.warnings.append(m)

    def fact(self, m):
        self.facts.append(m)

    def emit(self):
        score = max(0, 100 - 45 * len(self.criticals) - 12 * len(self.warnings))
        # Sanitize the echoed target: it is attacker-influenceable, and a newline
        # in it could otherwise forge a standalone "TRIAGE PASSED" verdict line.
        safe_target = str(self.target).replace("\n", " ").replace("\r", " ")
        print(f"Triage: {self.ttype} {safe_target}")
        print("-" * 50)
        for f in self.facts:
            print(f"  . {f}")
        for w in self.warnings:
            print(f"  ! WARNING: {w}")
        for c in self.criticals:
            print(f"  x CRITICAL: {c}")
        print()
        print(f"Health score: {score}/100")
        print(f"Critical issues: {len(self.criticals)}")
        print(f"Warnings: {len(self.warnings)}")
        if not self.criticals:
            print("TRIAGE PASSED")
        else:
            print("TRIAGE FAILED")


def triage_npm(rep):
    pkg = rep.target
    url = f"{NPM_REGISTRY}/{urllib.parse.quote(pkg, safe='@/')}"
    try:
        data, _ = _get_json(url)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            rep.critical(f"package '{pkg}' not found on the npm registry")
        else:
            rep.critical(f"npm registry returned HTTP {e.code} (cannot verify)")
        return
    except (urllib.error.URLError, TimeoutError, OSError):
        rep.critical("could not reach the npm registry (offline?) -- cannot verify")
        return

    latest = (data.get("dist-tags") or {}).get("latest")
    versions = data.get("versions") or {}
    meta = versions.get(latest, {}) if latest else {}
    times = data.get("time") or {}

    if meta.get("deprecated"):
        rep.critical(f"latest version {latest} is DEPRECATED: {str(meta.get('deprecated'))[:80]}")
    created_days = _days_since(times.get("created"))
    last_days = _days_since(times.get(latest)) if latest else None
    maint = data.get("maintainers") or meta.get("maintainers") or []

    rep.fact(f"latest {latest}, {len(versions)} versions, {len(maint)} maintainer(s)")
    if created_days is not None:
        rep.fact(f"first published {created_days} days ago")
        if created_days < NEW_DAYS:
            rep.warn(f"package is very new ({created_days} days) -- limited track record")
    if last_days is not None and last_days > ABANDONED_DAYS:
        rep.warn(f"no publish in {last_days} days -- possibly abandoned")
    if len(maint) <= 1:
        rep.warn("single maintainer -- bus-factor / takeover risk")


def triage_pip(rep):
    pkg = rep.target
    url = f"{PYPI_INDEX}/pypi/{urllib.parse.quote(pkg)}/json"
    try:
        data, _ = _get_json(url)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            rep.critical(f"package '{pkg}' not found on PyPI")
        else:
            rep.critical(f"PyPI returned HTTP {e.code} (cannot verify)")
        return
    except (urllib.error.URLError, TimeoutError, OSError):
        rep.critical("could not reach PyPI (offline?) -- cannot verify")
        return

    info = data.get("info") or {}
    releases = data.get("releases") or {}
    ver = info.get("version")
    files = releases.get(ver) or []
    if any(f.get("yanked") for f in files):
        rep.critical(f"latest version {ver} is YANKED")
    rep.fact(f"latest {ver}, {len(releases)} releases, author: {info.get('author') or 'unknown'}")
    last_iso = files[0].get("upload_time_iso_8601") if files else None
    last_days = _days_since(last_iso)
    if last_days is not None and last_days > ABANDONED_DAYS:
        rep.warn(f"no release in {last_days} days -- possibly abandoned")
    if not info.get("license") and not (info.get("classifiers") or []):
        rep.warn("no declared license -- review terms before use")


def _owner_repo(target):
    t = target.strip()
    t = t.replace("https://", "").replace("http://", "")
    t = t.replace("github.com/", "")
    if t.endswith(".git"):
        t = t[:-4]
    parts = [p for p in t.split("/") if p]
    if len(parts) >= 2:
        return f"{parts[0]}/{parts[1]}"
    return None


def triage_repo(rep):
    or_ = _owner_repo(rep.target)
    if not or_:
        rep.critical(f"could not parse owner/repo from '{rep.target}'")
        return
    headers = {}
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    try:
        data, _ = _get_json(f"{GITHUB_API}/repos/{or_}", headers=headers)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            rep.critical(f"repo '{or_}' not found (or private)")
        elif e.code in (403, 429):
            rep.critical("GitHub API rate-limited -- cannot verify (set GITHUB_TOKEN and retry)")
        else:
            rep.critical(f"GitHub API returned HTTP {e.code} (cannot verify)")
        return
    except (urllib.error.URLError, TimeoutError, OSError):
        rep.critical("could not reach GitHub (offline?) -- cannot verify")
        return

    rep.fact(f"{or_}: {data.get('stargazers_count', 0)} stars, "
             f"license: {(data.get('license') or {}).get('spdx_id') or 'none'}")
    if data.get("archived"):
        rep.critical(f"repo '{or_}' is ARCHIVED (read-only / unmaintained)")
    if data.get("disabled"):
        rep.critical(f"repo '{or_}' is DISABLED")
    pushed_days = _days_since(data.get("pushed_at"))
    created_days = _days_since(data.get("created_at"))
    if created_days is not None and created_days < NEW_DAYS:
        rep.warn(f"repo is very new ({created_days} days)")
    if pushed_days is not None and pushed_days > ABANDONED_DAYS:
        rep.warn(f"no push in {pushed_days} days -- possibly unmaintained")
    if not (data.get("license") or {}).get("spdx_id"):
        rep.warn("no detected license -- review terms before use")


def triage_docker(rep):
    repo = rep.target
    api_repo = repo if "/" in repo else f"library/{repo}"
    try:
        data, _ = _get_json(f"{DOCKER_REGISTRY}/v2/repositories/{api_repo}")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            rep.critical(f"image '{repo}' not found on Docker Hub")
        else:
            rep.critical(f"Docker Hub returned HTTP {e.code} (cannot verify)")
        return
    except (urllib.error.URLError, TimeoutError, OSError):
        rep.critical("could not reach Docker Hub (offline?) -- cannot verify")
        return
    rep.fact(f"{api_repo}: {data.get('pull_count', 0)} pulls, official={data.get('is_official', False)}")
    last_days = _days_since(data.get("last_updated"))
    if last_days is not None and last_days > ABANDONED_DAYS:
        rep.warn(f"image not updated in {last_days} days -- stale base / unpatched CVEs likely")
    if not data.get("is_official") and (data.get("pull_count") or 0) < 1000:
        rep.warn("unofficial image with low pull count -- verify the publisher")


def triage_skill(rep):
    target = rep.target
    # Local path -> validate the SKILL.md deterministically.
    candidates = [target, os.path.join(target, "SKILL.md")]
    path = next((p for p in candidates if os.path.isfile(p)), None)
    if path:
        try:
            with open(path, "r", encoding="utf-8") as f:
                text = f.read()
        except OSError as e:
            rep.critical(f"cannot read skill at '{path}': {e}")
            return
        head = text[:400]
        if not head.lstrip().startswith("---"):
            rep.critical("SKILL.md has no YAML frontmatter (--- ... ---)")
        if "name:" not in head:
            rep.warn("frontmatter missing 'name:'")
        if "description:" not in head:
            rep.warn("frontmatter missing 'description:'")
        # crude secret scan
        for marker in ("sk-", "ghp_", "AKIA", "-----BEGIN", "xoxb-", "AIza"):
            if marker in text:
                rep.critical(f"possible secret in skill body (matched '{marker}')")
        rep.fact(f"validated local skill at {path} ({len(text)} bytes)")
        return
    # Otherwise treat a name/owner-repo as a repo triage.
    rep.fact("no local SKILL.md found; treating target as a repo")
    triage_repo(rep)


def main(argv):
    if len(argv) < 1 or argv[0] == "tools":
        print("kit triage -- available checks:")
        print("  npm <pkg>        npm registry: existence, deprecation, age, maintainers")
        print("  pip <pkg>        PyPI: existence, yanked, age, license")
        print("  repo <owner/repo|url>   GitHub: archived, maintenance, license, age")
        print("  docker <image>   Docker Hub: existence, freshness, publisher")
        print("  skill <path|name>   validate a local SKILL.md, else repo-check")
        return 0
    ttype = argv[0]
    target = argv[1] if len(argv) > 1 else ""
    if ttype == "all" or not target:
        print(f"Usage: triage.py <npm|pip|repo|docker|skill> <target>")
        return 0
    rep = Report(ttype, target)
    dispatch = {
        "npm": triage_npm,
        "pip": triage_pip,
        "repo": triage_repo,
        "docker": triage_docker,
        "skill": triage_skill,
    }
    fn = dispatch.get(ttype)
    if not fn:
        rep.critical(f"unknown triage type '{ttype}'")
    else:
        fn(rep)
    rep.emit()
    return 0


if __name__ == "__main__":
    import urllib.parse  # noqa: E402  (kept local to module load is fine)
    sys.exit(main(sys.argv[1:]))
