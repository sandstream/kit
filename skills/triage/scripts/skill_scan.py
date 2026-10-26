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


def triage_local_skill(rep):
    """Validate a local skill (a SKILL.md or its directory). False when the target is not local."""
    target = rep.target
    path = next((p for p in (target, os.path.join(target, "SKILL.md")) if os.path.isfile(p)), None)
    if not path:
        return False
    try:
        with open(path, "r", encoding="utf-8") as f:
            text = f.read()
    except OSError as e:
        rep.critical(f"cannot read skill at '{path}': {e}")
        return True
    head = text[:400]
    if not head.lstrip().startswith("---"):
        rep.critical("SKILL.md has no YAML frontmatter (--- ... ---)")
    if "name:" not in head:
        rep.warn("frontmatter missing 'name:'")
    if "description:" not in head:
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
            try:
                if os.path.islink(full) or os.path.getsize(full) > FILE_LIMIT:
                    raise ValueError(name)
                with open(full, "r", encoding="utf-8") as f:
                    body = f.read()
            except (OSError, ValueError, UnicodeDecodeError):
                unread.append(os.path.relpath(full, skill_dir))
                continue
            read += 1
            _secrets_in(rep, os.path.relpath(full, skill_dir), body)
    rep.fact(f"scanned {read} other file(s) in the skill directory")
    if unread:
        more = f" and {len(unread) - 10} more" if len(unread) > 10 else ""
        rep.warn(f"not scanned (binary, symlink or over 1 MB): {', '.join(unread[:10])}{more}")
