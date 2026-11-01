"""Local Claude Code plugin triage for triage.py: what the plugin's hooks and scripts can do.

A plugin is more than its skills. Its hooks run on the agent's own tool calls and can block or
redirect them; its scripts run with the user's permissions. Triaging only the SKILL.md files
passed a plugin whose hooks block every large-file read and whose scripts upload the files to a
remote model (kit-research: spotify-shunt-plugin-vs-kit.md) at 100/100. This reads the manifest,
the hook registrations and every script, and reports what they do. Line scans only, no execution.

Split out of triage.py, which kit freezes at its current size. kit installs and byte-verifies this
file exactly as it does triage.py (src/triage.ts), so it carries the same provenance.
"""

import json
import os
import re

FILE_LIMIT = 1_000_000  # bytes; a larger file is reported unread, never skipped silently

# Tools whose interception changes what the agent can see or do.
SENSITIVE_TOOLS = ("Read", "Bash", "Edit", "Write", "MultiEdit", "WebFetch")
# Events whose output is injected into the agent's context or acts on its behalf.
CONTEXT_EVENTS = ("SessionStart", "UserPromptSubmit")

# A package runner fetching a package by name with no version runs whatever is newest, each time.
RUNNER = re.compile(r"\b(npx|bunx|uvx|pnpm\s+dlx|yarn\s+dlx|pipx\s+run)\s+((?:-{1,2}[\w-]+\s+)*)([^\s\"';|&)]+)")
# curl/wget sending a local file's bytes in the request body.
UPLOAD = re.compile(r"\b(curl|wget)\b[^\n]*(?:--data-binary\s+@|--data\s+@|-d\s+@|-F\s+\S+=@|--upload-file|-T\s|--post-file)")


def _load_json(rep, path, label):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError) as e:
        rep.critical(f"cannot read {label}: {type(e).__name__}")
        return None


def _pinned(spec):
    """True when a runner's package argument names a version: name@1.2.3 or @scope/name@1.2.3."""
    body = spec[1:] if spec.startswith("@") else spec
    return "@" in body and body.rsplit("@", 1)[1][:1].isdigit()


def _hook_sources(plugin_dir, manifest):
    """(label, events) for each hook registration: the manifest's inline `hooks`, the file it
    names, and hooks/hooks.json. events is None when the file cannot be read. A path that leaves
    the plugin directory is reported, never read."""
    declared = manifest.get("hooks") if isinstance(manifest, dict) else None
    if isinstance(declared, dict):
        yield "plugin.json", declared.get("hooks", declared)
    base = os.path.realpath(plugin_dir)
    seen = set()
    for rel in ([declared] if isinstance(declared, str) else []) + ["hooks/hooks.json"]:
        full = os.path.realpath(os.path.join(plugin_dir, rel))
        label = rel.replace(os.sep, "/")
        if full in seen or not os.path.isfile(full):
            continue
        seen.add(full)
        if not full.startswith(base + os.sep):
            yield label, "outside"
            continue
        try:
            with open(full, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, ValueError):
            yield label, None
            continue
        yield label, data.get("hooks", data) if isinstance(data, dict) else {}


def _report_hooks(rep, plugin_dir, manifest):
    registered = 0
    for source, events in _hook_sources(plugin_dir, manifest):
        if events == "outside":
            rep.critical(f"hook file {source} lies outside the plugin directory -- not read")
            continue
        if not isinstance(events, dict):
            rep.warn(f"hook registrations in {source} could not be read -- not inspected")
            continue
        for event, groups in events.items():
            for group in groups if isinstance(groups, list) else []:
                matcher = str(group.get("matcher", "*")) if isinstance(group, dict) else "*"
                cmds = group.get("hooks", []) if isinstance(group, dict) else []
                registered += len(cmds) if isinstance(cmds, list) else 0
                _judge_hook(rep, source, event, matcher)
    rep.fact(f"plugin registers {registered} hook command(s)")


def _judge_hook(rep, source, event, matcher):
    if event == "PreToolUse":
        hit = [t for t in SENSITIVE_TOOLS if matcher in ("*", "") or re.search(rf"\b{t}\b", matcher)]
        if hit:
            rep.warn(f"{source}: PreToolUse hook on {', '.join(hit)} -- can block or redirect the agent's own {', '.join(hit)} calls")
            return
    if event in CONTEXT_EVENTS:
        rep.warn(f"{source}: {event} hook -- its output is injected into the agent's context")
        return
    rep.fact(f"{source}: {event} hook (matcher {matcher!r})")


def _scan_script(rep, rel, text):
    for n, line in enumerate(text.splitlines(), 1):
        code = line.split("#", 1)[0] if not line.lstrip().startswith("#!") else ""
        for m in RUNNER.finditer(code):
            if not _pinned(m.group(3)) and not m.group(3).startswith("$"):
                rep.warn(f"{rel}:{n}: `{m.group(1)} {m.group(3)}` runs the newest published version on every call (unpinned)")
        if UPLOAD.search(code):
            rep.warn(f"{rel}:{n}: uploads a local file's contents over the network")


def _skill_frontmatter(rep, rel, text):
    head = text[:400]
    if not head.lstrip().startswith("---"):
        rep.critical(f"{rel}: no YAML frontmatter (--- ... ---)")
    elif "name:" not in head or "description:" not in head:
        rep.warn(f"{rel}: frontmatter missing 'name:' or 'description:'")


def _walk(plugin_dir):
    for root, dirs, files in os.walk(plugin_dir):
        dirs[:] = sorted(d for d in dirs if d != ".git")
        for name in sorted(files):
            yield os.path.join(root, name)


def triage_local_plugin(rep, secrets_in):
    """Triage a local Claude Code plugin directory (one with .claude-plugin/plugin.json)."""
    plugin_dir = rep.target
    manifest = _load_json(rep, os.path.join(plugin_dir, ".claude-plugin", "plugin.json"), "plugin.json")
    if isinstance(manifest, dict):
        rep.fact(f"plugin {manifest.get('name', '?')} {manifest.get('version', '')}".rstrip())
    _report_hooks(rep, plugin_dir, manifest or {})
    read, unread, skills = 0, [], 0
    for full in _walk(plugin_dir):
        rel = os.path.relpath(full, plugin_dir).replace(os.sep, "/")
        try:
            if os.path.islink(full) or os.path.getsize(full) > FILE_LIMIT:
                raise ValueError(rel)
            with open(full, "r", encoding="utf-8") as f:
                text = f.read()
        except (OSError, ValueError, UnicodeDecodeError):
            unread.append(rel)
            continue
        read += 1
        secrets_in(rep, rel, text)
        if os.path.basename(full) == "SKILL.md":
            skills += 1
            _skill_frontmatter(rep, rel, text)
        elif not rel.endswith((".md", ".json")):
            _scan_script(rep, rel, text)
    rep.fact(f"scanned {read} file(s): {skills} skill(s), hooks and scripts")
    if unread:
        more = f" and {len(unread) - 10} more" if len(unread) > 10 else ""
        rep.warn(f"not scanned (binary, symlink or over 1 MB): {', '.join(unread[:10])}{more}")
