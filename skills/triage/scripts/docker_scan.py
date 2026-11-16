"""Docker Hub triage for kit's triage.py, which loads this file by path (triage.py is size-frozen).

`kit triage docker <image>` checks that the image (and its tag) exists, its freshness and its
publisher. Pull count is reputation, not provenance: the backdoored ARTEX image (FBI FLASH
2026-11-13) reached 8,817 pulls within a month of its repository's registration, so a young
repository is a warning whatever its pull count.
"""
import urllib.error
import urllib.parse


def triage_docker(rep, t):
    """`t` is the triage.py module: its registry URL, HTTP helper, date helper and thresholds."""
    # Hub's repository API takes the bare name: `name:tag` or `name@sha256:…` there is HTTP 400.
    ref = rep.target.split("@", 1)[0]
    repo, _, tag = ref.rpartition(":") if ":" in ref.rsplit("/", 1)[-1] else (ref, "", "")
    api_repo = repo if "/" in repo else f"library/{repo}"
    try:
        data, _ = t._get_json(f"{t.DOCKER_REGISTRY}/v2/repositories/{api_repo}")
        if tag:  # the tag must exist too, or the name alone would vouch for any tag
            t._get_json(f"{t.DOCKER_REGISTRY}/v2/repositories/{api_repo}/tags/{urllib.parse.quote(tag)}")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            rep.critical(f"image '{rep.target}' not found on Docker Hub")
        else:
            rep.critical(f"Docker Hub returned HTTP {e.code} (cannot verify)")
        return
    except (urllib.error.URLError, TimeoutError, OSError):
        rep.critical("could not reach Docker Hub (offline?) -- cannot verify")
        return
    rep.fact(f"{api_repo}: {data.get('pull_count', 0)} pulls, official={data.get('is_official', False)}")
    last_days = t._days_since(data.get("last_updated"))
    if last_days is not None and last_days > t.ABANDONED_DAYS:
        rep.warn(f"image not updated in {last_days} days -- stale base / unpatched CVEs likely")
    if not data.get("is_official"):
        _unofficial(rep, data, t)


def _unofficial(rep, data, t):
    rep.fact("pull count is reputation, not provenance: it does not show this image was built "
             "from its published source")
    if (data.get("pull_count") or 0) < 1000:
        rep.warn("unofficial image with low pull count -- verify the publisher")
    registered_days = t._days_since(data.get("date_registered"))
    if registered_days is not None and registered_days < t.NEW_DAYS:
        rep.warn(f"image repository is very new ({registered_days} days) -- "
                 "a high pull count does not make it established")
