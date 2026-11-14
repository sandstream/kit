"""Local skill triage for triage.py: frontmatter, and a secret scan over every file.

Split out of triage.py, which kit freezes at its current size. kit installs and byte-verifies
this file exactly as it does triage.py (src/triage.ts), so it carries the same provenance.
"""

import os
import re

# Credential shapes, anchored so ordinary words are not credentials: the old bare `sk-`
# substring matched "ask-first", "task-" and "risk-" and failed real skills CRITICAL.
# Kept in step with the same families in src/utils/redactSecrets.ts.
SECRET_PATTERNS = (
    ("api key (sk-)", re.compile(r"\bsk-(?:(?:proj|ant|svcacct|admin)-[A-Za-z0-9_-]{20,}|[A-Za-z0-9]{40,})")),
    ("GitHub token", re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})")),
    ("AWS access key", re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b")),
    ("private key", re.compile(r"-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----")),
    ("Slack token", re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}")),
    ("Google API key", re.compile(r"\bAIza[0-9A-Za-z_-]{35}")),
)
FILE_LIMIT = 1_000_000  # bytes; a larger file is reported unread, never skipped silently


def _plugin_scan():
    """plugin_scan.py from this file's own directory, loaded by path (see triage.py's _skill_scan)."""
    import importlib.util
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "plugin_scan.py")
    spec = importlib.util.spec_from_file_location("kit_plugin_scan", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def is_local_path(t):
    """An absolute, relative, `~` or drive-letter path, or an existing local checkout: not a
    GitHub `owner/repo`. `kit triage repo /home/user/kit` used to query the repo `home/user`."""
    local = re.match(r"^(/|\\|\./|\.\./|~|[A-Za-z]:[\\/])", t) or t in (".", "..")
    return bool(local) or os.path.isdir(os.path.join(t, ".git"))


def _frontmatter_keys(text):
    """Top-level keys of the YAML frontmatter, or None when there is no closed block.

    A substring test (`"name:" in text[:400]`) accepted a Markdown heading `## name: x`, which
    is a YAML comment, and a block that never closed (kit-research `artex-vs-kit`). Only an
    unindented `key:` line between the opening and closing `---` counts.
    """
    lines = text.lstrip("\ufeff").splitlines()
    if not lines or lines[0].strip() != "---":
        return None
    keys = set()
    for line in lines[1:]:
        if line.strip() == "---":
            return keys
        m = re.match(r"^([A-Za-z_][A-Za-z0-9_-]*)\s*:", line)
        if m:
            keys.add(m.group(1))
    return None


def triage_local_skill(rep):
    """Validate a local skill (a SKILL.md or its directory). False when the target is not local."""
    target = rep.target
    # A Claude Code plugin is triaged as a plugin: its hooks and scripts carry the behaviour.
    if os.path.isfile(os.path.join(target, ".claude-plugin", "plugin.json")):
        _plugin_scan().triage_local_plugin(rep, _secrets_in)
        return True
    path = next((p for p in (target, os.path.join(target, "SKILL.md")) if os.path.isfile(p)), None)
    if not path:
        return False
    try:
        with open(path, "r", encoding="utf-8") as f:
            text = f.read()
    except OSError as e:
        rep.critical(f"cannot read skill at '{path}': {e}")
        return True
    keys = _frontmatter_keys(text)
    if keys is None:
        rep.critical("SKILL.md has no YAML frontmatter (--- ... ---)")
        keys = set()
    if "name" not in keys:
        rep.warn("frontmatter missing 'name:'")
    if "description" not in keys:
        rep.warn("frontmatter missing 'description:'")
    _secrets_in(rep, "skill body", text)
    if path != target:
        _scan_other_files(rep, os.path.dirname(path), path)
    rep.fact(f"validated local skill at {path} ({len(text)} bytes)")
    return True


def _secrets_in(rep, label, text):
    for kind, pattern in SECRET_PATTERNS:
        if pattern.search(text):
            rep.critical(f"possible secret in {label}: {kind}")


def _scan_other_files(rep, skill_dir, skill_md):
    """A skill's scripts are its code: a verdict that read only the prose would pass a skill
    whose script was never opened. Files that cannot be read as text are named, not skipped."""
    read, unread = 0, []
    for root, dirs, files in os.walk(skill_dir):
        dirs[:] = sorted(d for d in dirs if d != ".git")
        for name in sorted(files):
            full = os.path.join(root, name)
            if full == skill_md:
                continue
            rel = os.path.relpath(full, skill_dir).replace(os.sep, "/")  # same report on Windows
            try:
                if os.path.islink(full) or os.path.getsize(full) > FILE_LIMIT:
                    raise ValueError(name)
                with open(full, "r", encoding="utf-8") as f:
                    body = f.read()
            except (OSError, ValueError, UnicodeDecodeError):
                unread.append(rel)
                continue
            read += 1
            _secrets_in(rep, rel, body)
    rep.fact(f"scanned {read} other file(s) in the skill directory")
    if unread:
        more = f" and {len(unread) - 10} more" if len(unread) > 10 else ""
        rep.warn(f"not scanned (binary, symlink or over 1 MB): {', '.join(unread[:10])}{more}")
