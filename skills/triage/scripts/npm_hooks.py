"""npm install-hook and release-channel checks for kit's triage.py, which loads this file by path
(triage.py is size-frozen).

Both run after triage_npm on the version it resolved (`rep.npm_meta`, `rep.npm_tags`) and both
cost score: a package that runs code on `npm install`, and a version taken from a prerelease
channel rather than `latest`, are each a reason to look harder before installing.
"""
import re

# Registry-installed packages run these on `npm install` unless scripts are ignored.
NPM_INSTALL_HOOKS = ("preinstall", "install", "postinstall")
_PRERELEASE = re.compile(r"^v?\d+\.\d+\.\d+-")


def check_npm_install_hooks(rep):
    scripts = (getattr(rep, "npm_meta", None) or {}).get("scripts") or {}
    hooks = [h for h in NPM_INSTALL_HOOKS if h in scripts]
    if hooks:
        rep.warn(f"runs install script(s) on install: {', '.join(hooks)} (unless --ignore-scripts)")


def check_npm_channel(rep, spec):
    """Warn when the spec picked a dist-tag other than `latest`, or a prerelease version."""
    if not spec or spec == "latest" or not hasattr(rep, "npm_meta"):
        return
    tags = getattr(rep, "npm_tags", None) or {}
    version = str(rep.npm_meta.get("version") or tags.get(spec) or spec)
    if spec in tags or _PRERELEASE.match(version):
        rep.warn(
            f"'{spec}' ({version}) is a prerelease channel: it publishes far more often than "
            f"`latest` and is not what `latest` vouches for"
        )
