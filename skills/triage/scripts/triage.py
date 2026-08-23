#!/usr/bin/env python3
"""kit triage — deterministic, zero-LLM pre-install security evaluation.

Usage:
    triage.py <type> <target>
    type: npm | pip | repo | docker | skill | tools | all

kit (src/triage.ts) shells to this script and reads its STDOUT:
  - the line "TRIAGE PASSED" must be present for kit to treat the target as safe;
  - "Health score: N/100", "Critical issues: N", "Warnings: N" are parsed for the
    structured summary;
  - "Probes declared unavailable: N" and, when N > 0, a "Coverage: PARTIAL -- ..." line
    report probes this ecosystem's registry cannot answer. The score is a flat penalty
    count, so it falls out of how many probes an ecosystem HAS: a pip 100/100 ran one
    fewer probe than an npm 100/100 (PyPI publishes no maintainer list). Absence is
    printed rather than scored, matching kit's `didNotRun` rule that coverage which
    could not run is UNKNOWN, never clean.

Design contract (matches kit's watertight gate):
  - Deterministic. No LLM, no randomness. Same input + same upstream state => same verdict.
  - Dependency-light. Python stdlib only (urllib), so the skill is portable.
  - Fail-closed. If a registry cannot be reached (offline, timeout, error), that is a
    CRITICAL ("cannot verify") and "TRIAGE PASSED" is withheld, so kit blocks the install.
  - PASS rule: "TRIAGE PASSED" is printed when there are zero CRITICAL issues. Warnings
    are surfaced and scored but do not, by themselves, withhold PASS (criticals do).

Exit code is always 0 on a completed evaluation; kit reads the text, not the code.

Scope (what a PASS DOES and does NOT mean):
  - PASS means the SPECIFIC target — including a pinned version or dist-tag (`name@1.2.3`,
    `name@next`, `name==1.2.3`) — EXISTS and clears the health checks: not-found, deprecated,
    or yanked is a CRITICAL; newness / abandonment / single-maintainer / no-license are
    warnings. npm and pip run the same probe set; the maintainer count differs in KIND rather
    than presence -- npm reads the registry's publisher list, pip reads self-declared package
    metadata (`maintainer_email`, falling back to `author_email`) and says so, or declares the
    probe unavailable when the package names nobody. A pinned version is triaged directly, so a clean `latest` never vouches for a
    yanked or malicious pinned version.
  - PASS is NOT a malware verdict. This gate does no typosquat, install-script, or behavioral
    analysis. Deep malware detection is GuardDog (opt-in, separate + heavier: `KIT_GUARDDOG=1`
    or `[scan] guarddog = true`, run via `kit check`). Treat this as an existence + health +
    version gate, not proof the code is safe to run.
"""
import json
import os
import re
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
        self.notrun = []

    def critical(self, m):
        self.criticals.append(m)

    def warn(self, m):
        self.warnings.append(m)

    def fact(self, m):
        self.facts.append(m)

    def notchecked(self, probe, why, transient=False):
        """Record a probe that did not run.

        `transient=False` (the default) means this ecosystem's registry structurally cannot
        answer it — a permanent property, which is the #489 case. `transient=True` means the
        probe could normally run but its source was unreachable in THIS run. Collapsing the two
        would tell a reader that a repo's popularity is never knowable, when the truth is that
        the API was unreachable this time; the distinction is the whole point of declaring at
        all, so it survives into the summary line.

        The score is a flat penalty count (100 - 45*crit - 12*warn), so it falls out of how
        many probes an ecosystem HAS, not out of how safe the package is: before this, a pip
        package scored 100/100 while the npm path scored 88 for the same package shape, purely
        because npm exposes maintainer count and PyPI does not. Rather than let a number that
        ran fewer checks read as the cleaner one, absence is printed -- the same `didNotRun`
        semantics kit uses everywhere else, where coverage that could not run is UNKNOWN, not
        clean.
        """
        self.notrun.append((probe, why, transient))

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
        for probe, why, _transient in self.notrun:
            print(f"  ~ NOT CHECKED: {probe} -- {why}")
        print()
        print(f"Health score: {score}/100")
        print(f"Critical issues: {len(self.criticals)}")
        print(f"Warnings: {len(self.warnings)}")
        # Counts only what this path DECLARED it cannot answer -- never a completeness
        # claim about the probe set itself, which is documented per type above.
        print(f"Probes declared unavailable: {len(self.notrun)}")
        if self.notrun:
            # Without this line a 100/100 with a skipped probe is indistinguishable from a
            # 100/100 with everything green -- which is the defect (#489).
            probes = ", ".join(probe for probe, _, _ in self.notrun)
            # "cannot run for this ecosystem" is a permanent claim. Do not make it about a
            # source that merely happened to be unreachable — a retry may well fix that one.
            all_transient = all(transient for _, _, transient in self.notrun)
            scope = (
                "could not run in this run (source unreachable; retrying may resolve them)"
                if all_transient
                else "cannot run for this ecosystem"
            )
            print(
                f"Coverage: PARTIAL -- {len(self.notrun)} probe(s) {scope} "
                f"({probes}); the score covers only what was checked"
            )
        if not self.criticals:
            print("TRIAGE PASSED")
        else:
            print("TRIAGE FAILED")


def _split_npm_spec(target):
    """Split a npm target into (name, version|tag|None). Handles `@scope/name@ver`
    (the version `@` is the one AFTER the scope slash) and plain `name@ver`."""
    if target.startswith("@"):
        slash = target.find("/")
        at = target.find("@", slash + 1) if slash != -1 else -1
    else:
        at = target.find("@")
    if at > 0:
        return target[:at], target[at + 1:]
    return target, None


def _stable_semver(v):
    """(major, minor, patch) for a STABLE X.Y.Z (no pre-release/build), else None."""
    m = re.match(r"^(\d+)\.(\d+)\.(\d+)$", v)
    return (int(m.group(1)), int(m.group(2)), int(m.group(3))) if m else None


def _resolve_npm_spec(spec, version_keys):
    """Resolve a npm version spec to the concrete published version npm WOULD install — the
    MAX stable version satisfying it — or None if we can't parse it (→ caller fails closed).
    A leading `v` is tolerated (npm loose-parses it). Handles exact, `X`/`X.Y`/`X.x` partials,
    `^`, `~`, and single comparators (`>=`, `>`, `<`, `<=`, `=`). Compound/hyphen/`||` ranges
    return None (fail-closed) — they're rare in a CLI install and must not silently pass latest.
    """
    spec = spec.strip()
    if spec[1:2].isdigit() and spec[:1] == "v":
        spec = spec[1:]  # npm tolerates a leading v (v1.2.3 == 1.2.3)
    if spec in version_keys:
        return spec  # exact
    if any(c in spec for c in (" ", "||", " - ", ",")):
        return None  # compound/hyphen range — don't guess
    op = ""
    for o in (">=", "<=", "^", "~", ">", "<", "="):
        if spec.startswith(o):
            op, spec = o, spec[len(o):].strip()
            break
    if spec.startswith("v") and spec[1:2].isdigit():
        spec = spec[1:]
    nums = []
    for p in spec.split("."):
        if p in ("x", "X", "*", ""):
            break
        if not p.isdigit() or len(p) > 18:
            return None  # non-numeric or absurdly long component (avoid int() blowups)
        nums.append(int(p))
    if len(nums) > 3 or (op and not nums):
        return None  # not a 3-part semver / an operator with no version → don't guess
    base = tuple((nums + [0, 0, 0])[:3])

    def bump_partial():
        # x-range upper bound of a PARTIAL version: <=1 → 2.0.0, <=1.2 → 1.3.0, >1 → 2.0.0
        b = list(base)
        b[len(nums) - 1] += 1
        for j in range(len(nums), 3):
            b[j] = 0
        return tuple(b)

    def satisfies(t):
        if op == "^" and nums:
            # npm caret: bump the leftmost NON-ZERO component (or the last specified when all
            # are zero), zeroing the rest. ^1.2.3<2.0.0, ^0.2.3<0.3.0, ^0.0.3<0.0.4, ^0.0<0.1.0.
            idx = next((i for i, n in enumerate(nums) if n > 0), len(nums) - 1)
            hi = list(base)
            hi[idx] += 1
            for j in range(idx + 1, 3):
                hi[j] = 0
            return base <= t < tuple(hi)
        if op == "~" and nums:
            hi = (base[0], base[1] + 1, 0) if len(nums) >= 2 else (base[0] + 1, 0, 0)
            return base <= t < hi
        if op == ">=":
            return t >= base
        if op == "<":
            return t < base
        if op == "<=":  # partial <= desugars to an x-range bound (<=1 → <2.0.0)
            return t <= base if len(nums) >= 3 else t < bump_partial()
        if op == ">":  # partial > desugars likewise (>1 → >=2.0.0)
            return t > base if len(nums) >= 3 else t >= bump_partial()
        if op == "=":
            return t == base
        return all(i < len(t) and t[i] == n for i, n in enumerate(nums))  # bare partial: 1 → 1.x.x

    cands = sorted(t for t in (_stable_semver(v) for v in version_keys) if t and satisfies(t))
    if not cands:
        return None
    best = cands[-1]
    return f"{best[0]}.{best[1]}.{best[2]}"


def triage_npm(rep):
    pkg, spec = _split_npm_spec(rep.target)
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

    dist_tags = data.get("dist-tags") or {}
    versions = data.get("versions") or {}
    times = data.get("time") or {}
    latest = dist_tags.get("latest")

    # Resolve WHICH version to inspect for deprecation/existence. A dist-tag, an exact pin, or
    # a range/partial (`@2`, `@^1.2`, `@1.x`, `@v1.2.3`) is resolved to the concrete version npm
    # WOULD install -- a clean `latest` must never vouch for a yanked/deprecated/malicious pinned
    # or in-range version. An unresolvable spec fails CLOSED (never silently passes latest).
    target_ver = latest
    if spec:
        if spec in dist_tags:
            target_ver = dist_tags[spec]
        else:
            resolved = _resolve_npm_spec(spec, list(versions.keys()))
            if resolved:
                target_ver = resolved
            else:
                rep.critical(
                    f"version spec '{spec}' of '{pkg}' could not be resolved to a published "
                    f"version (yanked/unpublished/unsupported range) -- cannot verify"
                )
                return

    meta = versions.get(target_ver, {}) if target_ver else {}
    if meta.get("deprecated"):
        rep.critical(f"version {target_ver} is DEPRECATED: {str(meta.get('deprecated'))[:80]}")
    created_days = _days_since(times.get("created"))
    last_days = _days_since(times.get(latest)) if latest else None
    maint = data.get("maintainers") or meta.get("maintainers") or []

    tag = f" (latest {latest})" if target_ver != latest else ""
    rep.fact(f"triaged {target_ver}{tag}, {len(versions)} versions, {len(maint)} maintainer(s)")
    if created_days is not None:
        rep.fact(f"first published {created_days} days ago")
        if created_days < NEW_DAYS:
            rep.warn(f"package is very new ({created_days} days) -- limited track record")
    if last_days is not None and last_days > ABANDONED_DAYS:
        rep.warn(f"no publish in {last_days} days -- possibly abandoned")
    if len(maint) <= 1:
        rep.warn("single maintainer -- bus-factor / takeover risk")
    # License parity with the pip path, which has warned on a missing license since it was
    # written. Comparability breaks in both directions: an npm 100 must not be a 100 that
    # never looked at the terms.
    if not (meta.get("license") or data.get("license")):
        rep.warn("no declared license -- review terms before use")


def _split_pip_spec(target):
    """Split a pip requirement into (name, spec|None), dropping any `[extras]`.
    e.g. `requests[security]==1.2.3` -> ('requests', '==1.2.3'); `Flask>=2` -> ('Flask', '>=2')."""
    m = re.match(r"^([A-Za-z0-9][\w.-]*)(?:\[[\w,.-]*\])?\s*(.*)$", target)
    if not m:
        return target, None
    spec = m.group(2).strip()
    return m.group(1), (spec or None)


def _pep_release(v):
    """Numeric release tuple of a PEP 440 version (epoch/pre/post/dev ignored), else None."""
    m = re.match(r"^(?:\d+!)?(\d+(?:\.\d+)*)", v)
    if not m:
        return None
    parts = m.group(1).split(".")
    if any(len(p) > 18 for p in parts):  # avoid int() blowups on absurd input
        return None
    return tuple(int(x) for x in parts)


def _pep_stable(v):
    """True for a plain release version (no a/b/rc/dev/post pre-release suffix)."""
    return re.match(r"^(?:\d+!)?\d+(?:\.\d+)*$", v) is not None


def _resolve_pip_spec(spec, release_keys):
    """Resolve a single pip version spec to the concrete release pip WOULD install (max
    satisfying), or None if unparseable/compound (→ caller fails closed). Handles
    `==`/`===`/`==X.*`, `>=`,`>`,`<`,`<=`,`!=`,`~=`. Compound (`,`) ranges return None."""
    spec = spec.strip()
    if "," in spec:
        return None
    m = re.match(r"^(===|==|~=|>=|<=|!=|>|<)\s*([0-9][\w.*!+-]*)$", spec)
    if not m:
        return None
    op, ver = m.group(1), m.group(2)
    if op in ("==", "==="):
        if op == "==" and ver.endswith(".*"):
            pref = ver[:-2]
            # STABLE releases only — pip excludes pre-releases from `==X.*` without --pre.
            cands = sorted(
                (
                    r
                    for r in release_keys
                    if _pep_stable(r) and (r == pref or r.startswith(pref + "."))
                ),
                key=lambda r: _pep_release(r) or (),
            )
            return cands[-1] if cands else None
        return ver if ver in release_keys else None
    want = _pep_release(ver)
    if want is None:
        return None

    def ok(t):
        # Compare zero-padded to equal length: PEP 440 treats 2.20 == 2.20.0, so a bare
        # `<=2.20` must include 2.20.0 (Python tuple compare would otherwise exclude it).
        n = max(len(t), len(want))
        tt = tuple(t) + (0,) * (n - len(t))
        ww = tuple(want) + (0,) * (n - len(want))
        if op == ">=":
            return tt >= ww
        if op == ">":
            return tt > ww
        if op == "<=":
            return tt <= ww
        if op == "<":
            return tt < ww
        if op == "!=":
            return tt != ww
        if op == "~=" and len(want) >= 2:  # compatible release: >= want, same prefix minus last
            return tt >= ww and t[: len(want) - 1] == want[: len(want) - 1]
        return False

    cands = sorted(
        (r for r in release_keys if _pep_stable(r) and _pep_release(r) and ok(_pep_release(r))),
        key=lambda r: _pep_release(r),
    )
    return cands[-1] if cands else None


def _declared_maintainers(info):
    """Count the maintainers a PyPI package DECLARES, or (None, reason) when it declares none.

    Reads `maintainer_email` first (its purpose), falling back to `author_email` (what PEP 621
    actually fills in). Counting is bracket-aware: display names may contain commas
    ("Cordasco, Ian <x@y>"), so `<...>` pairs are counted when present and only a bracket-free
    value is split on commas. Returns (count, field_name) or (None, None).
    """
    for field in ("maintainer_email", "author_email", "maintainer", "author"):
        raw = (info.get(field) or "").strip()
        if not raw:
            continue
        brackets = re.findall(r"<[^<>@\s]+@[^<>\s]+>", raw)
        if brackets:
            return len(brackets), field
        parts = [p.strip() for p in raw.split(",") if p.strip()]
        if parts:
            return len(parts), field
    return None, None


def triage_pip(rep):
    pkg, spec = _split_pip_spec(rep.target)
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
    latest = info.get("version")

    # A pin or range is resolved to the concrete release pip WOULD install (max satisfying) and
    # checked directly -- a clean latest must not vouch for a yanked/older in-range version. An
    # unresolvable/compound spec fails CLOSED rather than silently passing latest.
    ver = latest
    if spec:
        resolved = _resolve_pip_spec(spec, list(releases.keys()))
        if resolved:
            ver = resolved
        else:
            rep.critical(
                f"version spec '{spec}' of '{pkg}' could not be resolved to a published "
                f"release (yanked/unpublished/unsupported range) -- cannot verify"
            )
            return

    files = releases.get(ver) or []
    if any(f.get("yanked") for f in files):
        rep.critical(f"version {ver} is YANKED")
    tag = f" (latest {latest})" if ver != latest else ""
    # `info.author` is null for every PEP 621 package: `authors = [{name=..., email=...}]`
    # lands in `author_email` instead, so the old fallback printed "author: unknown" for
    # essentially all modern Python packages -- and attribution is what settles a
    # look-alike-repo provenance question cheaply.
    author = info.get("author") or info.get("author_email") or "unknown"
    rep.fact(f"triaged {ver}{tag}, {len(releases)} releases, author: {author}")
    last_iso = files[0].get("upload_time_iso_8601") if files else None
    last_days = _days_since(last_iso)
    if last_days is not None and last_days > ABANDONED_DAYS:
        rep.warn(f"no release in {last_days} days -- possibly abandoned")
    if not info.get("license") and not (info.get("classifiers") or []):
        rep.warn("no declared license -- review terms before use")

    # Newness parity with the npm path. PyPI has no "created" field, but every release file
    # carries its upload time, so first-publish is the OLDEST one -- the probe was absent,
    # not impossible.
    first_days = None
    for rel_files in releases.values():
        for f in rel_files or []:
            d = _days_since(f.get("upload_time_iso_8601") or f.get("upload_time"))
            if d is not None and (first_days is None or d > first_days):
                first_days = d
    if first_days is not None:
        rep.fact(f"first published {first_days} days ago")
        if first_days < NEW_DAYS:
            rep.warn(f"package is very new ({first_days} days) -- limited track record")

    # Maintainer count. The earlier claim here -- "PyPI publishes no maintainer list" -- was
    # wrong, and measured wrong: requests carries
    #   maintainer_email = "Ian Stapleton Cordasco <...>, Nate Prewitt <...>"
    # which is countable. Two caveats decide how it is reported:
    #   1. same trap as `author`: `maintainer` is null under PEP 621 and the value lives in
    #      `maintainer_email`; opensandbox-server had maintainer_email null with one entry in
    #      author_email, so a counter must weigh both and be able to answer "don't know";
    #   2. the SEMANTICS differ from npm's. npm's list is the registry's own -- who may publish.
    #      PyPI's is self-declared metadata inside the package. Two names in a field are not
    #      evidence of two accounts with publish rights, so this must not be presented as npm's
    #      number.
    count, source = _declared_maintainers(info)
    if count is None:
        rep.notchecked(
            "maintainer count",
            "neither maintainer_email nor author_email names anyone for this package, and "
            "PyPI's JSON API does not expose registry publish rights -- bus-factor / "
            "account-takeover risk was NOT assessed",
        )
    else:
        rep.fact(f"{count} declared maintainer(s) in {source} (self-declared package metadata)")
        if count <= 1:
            rep.warn(
                f"single declared maintainer in {source} -- bus-factor risk. NOTE: this is "
                "self-declared metadata, not registry publish rights; PyPI does not expose who "
                "may publish, so it is not comparable to npm's maintainer count"
            )


# Hosts whose repos this probe can actually verify. It answers via the GitHub
# API, so any other host cannot be checked here and must SAY so — never have its
# hostname promoted to an "owner", which produced a confident 404 about a repo
# that never existed (kit#532).
_REPO_HOSTS = ("github.com",)

# Hosts that are not github.com but whose paths still begin with `owner/repo` of a
# real GitHub repo. Refusing these would be technically true and practically wrong:
# a piped installer is usually cited by its raw URL, and that URL names the repo
# unambiguously. Anything not listed here is still refused.
_REPO_PATH_HOSTS = ("raw.githubusercontent.com", "codeload.github.com")


def _owner_repo(target):
    """Reduce a repo reference to `owner/repo`.

    Returns `(owner_repo, None)` on success and `(None, reason)` on refusal. The
    two refusals are kept apart on purpose: an unsupported host is a different
    finding from a string with no owner/repo shape, and collapsing them is what
    made a non-GitHub URL look like a missing GitHub repo.

    Accepts the shorthand plus every equivalent spelling of the same repo:
    `owner/repo`, `[https://][www.]github.com/owner/repo[/tree/main][.git]`,
    and `git@github.com:owner/repo[.git]`.
    """
    t = target.strip()
    # scp-style `git@host:owner/repo` -> `host/owner/repo`, so one path below fits both.
    scp = re.match(r"^[\w.+-]+@([\w.-]+):(.+)$", t)
    if scp:
        t = f"{scp.group(1)}/{scp.group(2)}"
    else:
        t = re.sub(r"^[a-zA-Z][a-zA-Z0-9+.-]*://", "", t)
    t = t.split("?")[0].split("#")[0]

    parts = [p for p in t.split("/") if p]
    if not parts:
        return None, f"could not parse owner/repo from '{target}'"

    if parts[0].lower().startswith("www."):
        parts[0] = parts[0][4:]
    # A dotted first segment is a hostname, not an owner: GitHub usernames are
    # alphanumeric + hyphen and never contain a dot, so this split is unambiguous.
    if "." in parts[0]:
        host = parts.pop(0).lower()
        if host not in _REPO_HOSTS and host not in _REPO_PATH_HOSTS:
            return None, (
                f"'{target}' is not a github.com repo URL -- this probe verifies repos "
                f"through the GitHub API and cannot check {host}"
            )

    if len(parts) < 2:
        return None, f"could not parse owner/repo from '{target}'"
    owner, repo = parts[0], parts[1]
    if repo.endswith(".git"):
        repo = repo[:-4]
    if not owner or not repo:
        return None, f"could not parse owner/repo from '{target}'"
    return f"{owner}/{repo}", None


def _api_message(e):
    """The API's own explanation for an error, when it gives one.

    A 403 has many causes — quota, token scope, SSO, an egress policy, a session that has not
    been granted the repo — and guessing between them produced confidently wrong advice.
    GitHub (and anything proxying it) answers with a JSON `message`, so quote that instead of
    inferring. Remote text reaching operator output, so: bounded read, control characters
    stripped, single line, truncated.
    """
    try:
        raw = e.read(4096)
    except Exception:
        return None
    if not raw:
        return None
    try:
        msg = json.loads(raw.decode("utf-8", "replace")).get("message")
    except Exception:
        return None
    if not isinstance(msg, str) or not msg.strip():
        return None
    one_line = " ".join(msg.split())
    clean = "".join(ch for ch in one_line if ch.isprintable())
    return clean[:300] if clean else None


def _forbidden_reason(e, token_sent):
    """Explain a 403/429 from the GitHub API without guessing.

    Quota exhaustion is a header fact (`x-ratelimit-remaining: 0`), so it is reported as one.
    Anything else 403 is *forbidden*, which is a different problem with a different fix, and
    telling the operator to set a token they have already set sends them in a circle.
    """
    hdrs = getattr(e, "headers", None)
    remaining = None
    if hdrs is not None:
        try:
            remaining = hdrs.get("x-ratelimit-remaining")
        except Exception:
            remaining = None
    exhausted = remaining is not None and str(remaining).strip() == "0"

    if e.code == 429 or exhausted:
        hint = "wait for the window to reset" if token_sent else "set GITHUB_TOKEN to raise the limit"
        return f"GitHub API rate limit reached -- cannot verify ({hint})"

    # Quota is intact, so this is not the limit. Prefer what the API said over what we'd guess.
    said = _api_message(e)
    if said:
        return f"GitHub API returned {e.code} -- cannot verify: {said}"
    if token_sent:
        return (
            f"GitHub API returned {e.code} with quota remaining and no explanation -- cannot "
            "verify. A token IS set, so this is not the rate limit: check its scopes/SSO "
            "authorization, or whether a proxy or firewall is intercepting api.github.com"
        )
    return (
        f"GitHub API returned {e.code} and no token was sent -- cannot verify (set GITHUB_TOKEN; "
        "if one is already set, check its scopes/SSO or a proxy intercepting api.github.com)"
    )


# What the GitHub API answers for a repo, and therefore what is UNKNOWN when it cannot be
# reached. Naming them individually rather than saying "the API failed" is the point: a reader
# has to be able to see WHICH coverage is missing, and `Probes declared unavailable: 0` while
# zero probes ran is the same false-green shape kit rejects everywhere else.
_REPO_API_PROBES = (
    ("popularity", "stargazers_count comes only from the GitHub API"),
    ("license", "license.spdx_id comes only from the GitHub API"),
    ("archived/disabled", "repo lifecycle state comes only from the GitHub API"),
    ("repo age", "created_at comes only from the GitHub API"),
    ("recent activity", "pushed_at comes only from the GitHub API"),
)


def _declare_repo_probes_unavailable(rep):
    """Mark every API-backed repo probe as not run.

    Deliberately NOT paired with a git fallback. Deriving dates or the license would mean
    cloning, and `kit triage repo` exists to be run BEFORE you fetch a repo — a triage that
    fetches in order to judge whether you should fetch inverts the order it enforces. So the
    honest answer is that this coverage is missing, not a substitute for it.
    """
    for probe, why in _REPO_API_PROBES:
        rep.notchecked(probe, why, transient=True)


def triage_repo(rep):
    or_, refusal = _owner_repo(rep.target)
    if refusal:
        rep.critical(refusal)
        return
    headers = {}
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    try:
        data, _ = _get_json(f"{GITHUB_API}/repos/{or_}", headers=headers)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            # A definite answer, not a coverage gap: the API replied that there is no such
            # repo. Nothing is left unknown, so no probe is declared unavailable here.
            rep.critical(f"repo '{or_}' not found (or private)")
            return
        if e.code in (403, 429):
            # 403 and 429 are NOT the same thing, and the old single message told every
            # caller to "set GITHUB_TOKEN and retry" — wrong advice when a token is already
            # set and the 403 came from a proxy, an SSO requirement, or a scope gap. GitHub
            # sends the quota in headers, so exhaustion is checkable rather than assumed.
            rep.critical(_forbidden_reason(e, token_sent=bool(token)))
        else:
            rep.critical(f"GitHub API returned HTTP {e.code} (cannot verify)")
        _declare_repo_probes_unavailable(rep)
        return
    except (urllib.error.URLError, TimeoutError, OSError):
        rep.critical("could not reach GitHub (offline?) -- cannot verify")
        _declare_repo_probes_unavailable(rep)
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
        # Fail CLOSED on any unexpected error: an escaping exception would skip rep.emit()
        # entirely (no verdict line → kit can't see a PASS, but also no explicit block). Turn
        # it into a CRITICAL so the gate always renders a decisive, safe verdict.
        try:
            fn(rep)
        except Exception as e:  # noqa: BLE001 -- deliberate catch-all for a fail-closed gate
            rep.critical(f"triage error ({type(e).__name__}) -- cannot verify")
    rep.emit()
    return 0


if __name__ == "__main__":
    import urllib.parse  # noqa: E402  (kept local to module load is fine)
    sys.exit(main(sys.argv[1:]))
