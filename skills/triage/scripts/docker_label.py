"""The OCI source label of a Docker Hub image, for docker_scan.py (loaded by path, like it).

The backdoored ARTEX image (FBI FLASH 2026-11-13) was clean in source and dirty only in its
bytes, so the most a metadata check can say is where the image CLAIMS it was built from:
`org.opencontainers.image.source` and `.revision`. This reads them from the registry's manifest
and config blob only. No layer is fetched and nothing from the image runs. The label is the
publisher's own claim and is not signed, so a match is not proof; a missing label, or one whose
owner is not the image's namespace, is a warning.
"""
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request

# The OCI distribution API, separate from Hub's `/v2/repositories` metadata API.
REGISTRY = os.environ.get("KIT_DOCKER_V2_REGISTRY", "https://registry-1.docker.io").rstrip("/")
SOURCE, REVISION = "org.opencontainers.image.source", "org.opencontainers.image.revision"
MAX_BYTES = 1 << 20  # manifests and configs are kilobytes; refuse to buffer more than this
ACCEPT = ", ".join([
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
])
_PROBE = "OCI source label"


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Blobs redirect to a CDN. Follow by hand, so the bearer token is not sent to that host."""

    def redirect_request(self, *args, **kwargs):
        return None


def check_source_label(rep, api_repo, reference, ua):
    """Print the image's source label and warn when it is missing or names another owner."""
    if "KIT_DOCKER_REGISTRY" in os.environ and "KIT_DOCKER_V2_REGISTRY" not in os.environ:
        rep.notchecked(_PROBE, "Hub metadata comes from a mirror and KIT_DOCKER_V2_REGISTRY is "
                               "not set, so the public registry is not asked")
        return
    try:
        labels = _labels(api_repo, reference or "latest", ua)
    except (urllib.error.URLError, TimeoutError, OSError, ValueError, KeyError) as e:
        rep.notchecked(_PROBE, f"registry manifest or config not readable ({_reason(e)})", True)
        return
    _judge(rep, api_repo, labels)


def _judge(rep, api_repo, labels):
    namespace = api_repo.split("/", 1)[0]
    source = _clean(labels.get(SOURCE))
    if not source:
        if namespace != "library":
            rep.warn(f"no {SOURCE} label -- the image does not say which source it was built "
                     "from, so nothing ties it to a repository")
        else:
            rep.fact(f"no {SOURCE} label (official image; built by Docker's library program)")
        return
    revision = _clean(labels.get(REVISION))
    rep.fact(f"source label: {source}" + (f" @ {revision}" if revision else "")
             + " -- the publisher's own claim, unsigned; check it with `kit triage repo`")
    owner = _owner(source)
    if namespace == "library":
        return
    if owner is None:
        rep.warn(f"{SOURCE} label does not name a repository: {source}")
    elif owner.lower() != namespace.lower():
        rep.warn(f"{SOURCE} names owner '{owner}', not the image's namespace '{namespace}' -- "
                 "a rebuild of someone else's source; compare the image with that source")


def _owner(source):
    """The owner segment of a repository URL (https://host/owner/repo, git@host:owner/repo)."""
    m = re.match(r"^(?:[a-z][a-z0-9+.-]*://)?(?:[^@/]+@)?[^/:]+[/:]([^/]+)/[^/]+", source, re.I)
    return m.group(1) if m else None


def _clean(value):
    """The label is attacker-written: one printable line, credentials stripped, length capped."""
    if not isinstance(value, str):
        return ""
    text = re.sub(r"[\x00-\x1f\x7f  ]+", " ", value).strip()
    return re.sub(r"://[^\s/@]{1,256}@", "://", text)[:200]


def _reason(e):
    return f"HTTP {e.code}" if isinstance(e, urllib.error.HTTPError) else type(e).__name__


def _labels(api_repo, reference, ua):
    """Annotations of the index and manifest, then the config's Labels (the config wins)."""
    session = _Session(api_repo, ua)
    doc = session.json(f"/manifests/{urllib.parse.quote(reference, safe=':@')}", ACCEPT)
    found = dict(doc.get("annotations") or {})
    if "manifests" in doc:  # an index: pick one platform's manifest
        digest = _pick_platform(doc["manifests"])
        doc = session.json(f"/manifests/{digest}", ACCEPT)
        found.update(doc.get("annotations") or {})
    config = session.json(f"/blobs/{doc['config']['digest']}", "application/json")
    found.update((config.get("config") or {}).get("Labels") or {})
    return found


def _pick_platform(entries):
    images = [m for m in entries if (m.get("platform") or {}).get("os") not in (None, "unknown")]
    for m in images:
        if m["platform"].get("os") == "linux" and m["platform"].get("architecture") == "amd64":
            return m["digest"]
    if not images:
        raise ValueError("index lists no image manifest")
    return images[0]["digest"]


class _Session:
    """Anonymous pull access: a 401 names the token service, which hands out a pull token."""

    def __init__(self, api_repo, ua):
        self.base = f"{REGISTRY}/v2/{api_repo}"
        self.scope = f"repository:{api_repo}:pull"
        self.ua = ua
        self.token = None
        self.opener = urllib.request.build_opener(_NoRedirect)

    def json(self, path, accept):
        try:
            return json.loads(self._get(self.base + path, accept, auth=True))
        except urllib.error.HTTPError as e:
            if e.code != 401 or self.token is not None:
                raise
            self.token = _token(e.headers.get("WWW-Authenticate", ""), self.scope, self.ua)
            return json.loads(self._get(self.base + path, accept, auth=True))

    def _get(self, url, accept, auth):
        headers = dict(self.ua, Accept=accept)
        if auth and self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        # Host is the operator's registry (or the redirect it names); only the path varies.
        # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected
        req = urllib.request.Request(url, headers=headers)
        try:
            with self.opener.open(req, timeout=15) as r:
                return _read(r)
        except urllib.error.HTTPError as e:
            location = e.headers.get("Location") if e.code in (301, 302, 303, 307, 308) else None
            if not location or not auth:  # one redirect, the blob's CDN; never a second hop
                raise
            target = urllib.parse.urljoin(url, location)
            if not target.startswith(("https://", "http://")):
                raise ValueError("registry redirected outside http(s)")
            return self._get(target, accept, auth=False)


def _token(challenge, scope, ua):
    params = dict(re.findall(r'(\w+)="([^"]*)"', challenge))
    realm = params.get("realm", "")
    if not challenge.lower().startswith("bearer ") or not realm.startswith(("https://", "http://")):
        raise ValueError("registry asked for credentials that are not an anonymous bearer token")
    query = urllib.parse.urlencode({"service": params.get("service", ""), "scope": scope})
    # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected
    with urllib.request.urlopen(urllib.request.Request(f"{realm}?{query}", headers=ua),
                                timeout=15) as r:
        body = json.loads(_read(r))
    return body.get("token") or body["access_token"]


def _read(response):
    data = response.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError("registry document over 1 MiB")
    return data
