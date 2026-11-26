"""Local skill triage for triage.py: frontmatter, and a secret scan over every file.

Split out of triage.py, which kit freezes at its current size. kit installs and byte-verifies
this file exactly as it does triage.py (src/triage.ts), so it carries the same provenance.
"""

import json
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


SKILL_PACK_DEPTH = 4  # skills/<name>/SKILL.md, automations/<a>/skills/<name>/SKILL.md
SKILL_PACK_LIMIT = 200


def triage_local_skill(rep):
    """Validate a local skill (a SKILL.md or its directory), or every skill in a local pack. False
    when the target is not local."""
    target = rep.target
    # A Claude Code plugin is triaged as a plugin: its hooks and scripts carry the behaviour.
    if os.path.isfile(os.path.join(target, ".claude-plugin", "plugin.json")):
        _plugin_scan().triage_local_plugin(rep, _secrets_in)
        return True
    # A plugin marketplace is triaged plugin by plugin: it holds plugins, not skills.
    if os.path.isfile(os.path.join(target, ".claude-plugin", "marketplace.json")):
        _plugin_scan().triage_local_marketplace(rep, _secrets_in)
        return True
    path = next((p for p in (target, os.path.join(target, "SKILL.md")) if os.path.isfile(p)), None)
    if path:
        _triage_skill_file(rep, path, path != target, "")
        return True
    if not (os.path.isdir(target) or is_local_path(target)):
        return False
    # A pack (`skills/<name>/SKILL.md`) is triaged skill by skill. Without this a local pack fell
    # through to repo triage, whose refusal told the operator to run the command they had just run
    # (kit-research `pstack-vs-kit`).
    skills = _skills_under(target) if os.path.isdir(target) else []
    if not skills:
        rep.critical(f"no SKILL.md in '{target}' or the {SKILL_PACK_DEPTH} directory levels below it")
        return True
    for skill_md in skills[:SKILL_PACK_LIMIT]:
        rel = os.path.relpath(os.path.dirname(skill_md), target).replace(os.sep, "/")
        _triage_skill_file(rep, skill_md, True, f"{rel}: ")
    if len(skills) > SKILL_PACK_LIMIT:
        rep.warn(f"only the first {SKILL_PACK_LIMIT} of {len(skills)} skills were triaged; "
                 "triage the pack's subdirectories one by one to read the rest")
        rep.incomplete(f"{len(skills) - SKILL_PACK_LIMIT} of {len(skills)} skill(s) not read")
    rep.fact(f"triaged {min(len(skills), SKILL_PACK_LIMIT)} skill(s) in the pack at {target}")
    _declare_outside_skills(rep, target, skills)
    return True


# Files at a pack's root that describe the pack to people and are not installed into a project.
_PACK_META = re.compile(r"^(readme|license|licence|changelog|contributing|version|notice|"
                        r"code_of_conduct|security|authors)([.-].*)?$", re.IGNORECASE)


# Dot-files at a pack's root that only tell git or the OS how to handle the tree.
_ROOT_DOT_META = {".gitignore", ".gitattributes", ".gitmodules", ".DS_Store", ".editorconfig"}
# The pack repository's own git data and CI, which installing a skill does not bring along.
_ROOT_SKIP_DIRS = {".git", ".github", "node_modules"}


def _outside_skills(root, skills):
    """Files in the pack that no skill directory holds, minus root metadata, `.git` and `.github`. Dot-directories
    at the root are read: `.claude/settings.json`, `.mcp.json`, `.githooks` and `.husky` hold the hooks
    and servers an agent runs, and skipping them passed a `curl | sh` SessionStart hook at 100/100."""
    skill_dirs = {os.path.dirname(s) for s in skills}
    out = []
    for current, dirs, files in os.walk(root):
        if current == root:
            dirs[:] = sorted(d for d in dirs if d not in _ROOT_SKIP_DIRS)
            files = [f for f in files if f not in _ROOT_DOT_META and not _PACK_META.match(f)]
        else:
            dirs[:] = sorted(d for d in dirs if d not in (".git", "node_modules"))
        dirs[:] = [d for d in dirs if os.path.join(current, d) not in skill_dirs]
        for name in sorted(files):
            out.append(os.path.relpath(os.path.join(current, name), root).replace(os.sep, "/"))
    return out


def _declare_outside_skills(rep, root, skills):
    """A pack can ship hooks, setup instructions and scripts beside its skills (kit-research
    `humanmaxxing-vs-kit`: a hooks fragment and a getting-started file an agent is told to follow).
    Hook fragments and scripts are judged as a plugin's are; the rest is declared not checked,
    never passed silently."""
    rest = _read_hooks_and_scripts(rep, root, _read_pack_mcp(rep, root, _outside_skills(root, skills)))
    if not rest:
        return
    more = f" and {len(rest) - 10} more" if len(rest) > 10 else ""
    rep.notchecked(f"{len(rest)} file(s) outside the skill directories",
                   f"pack triage reads skill directories, hook fragments and scripts only: {', '.join(rest[:10])}{more}")


_HOOK_SCRIPTS = (".sh", ".py", ".js")
# A pack's root MCP configs, loaded when it is installed as a project: Claude Code's `.mcp.json`
# and Codex's `[mcp_servers.<name>]` tables in `.codex/config.toml`.
_PACK_MCP = (".mcp.json", ".codex/config.toml")


def _read_pack_mcp(rep, root, rest):
    """Judge the MCP servers a pack's root `.mcp.json` and `.codex/config.toml` register, by the
    rules a plugin's are judged by; return the files still unread. Both used to be declared not
    checked, so `npx -y server@latest` and a remote host read as nothing to flag (kit-research
    `uber-skills-at-scale-vs-kit`). A `config.toml` holding more than `mcp_servers` stays declared."""
    plugin = _plugin_scan()
    left, count = [], 0
    for rel in rest:
        servers, whole = _pack_mcp_servers(root, rel) if rel in _PACK_MCP else (None, False)
        if not whole:
            left.append(rel)
        for name, server in servers or []:
            plugin.judge_mcp_server(rep, rel, name, server, "pack")
        count += len(servers or [])
    if count:
        rep.fact(f"pack registers {count} MCP server(s) outside the skill directories")
    return left


def _pack_mcp_servers(root, rel):
    """([(name, server)], whole_file_read) for a root MCP config; (None, False) when it does not
    parse, or when this Python has no `tomllib` (3.11+) for the TOML one."""
    text = _read_text(os.path.join(root, *rel.split("/")))
    try:
        if text is None:
            return None, False
        if rel.endswith(".toml"):
            import tomllib
            data = tomllib.loads(text)
            servers, whole = data.get("mcp_servers", {}), set(data) <= {"mcp_servers"}
        else:
            data = json.loads(text)
            servers = data.get("mcpServers", data) if isinstance(data, dict) else {}
            whole = True
    except (ImportError, ValueError):
        return None, False
    if not isinstance(servers, dict):
        return None, False
    return [(n, v) for n, v in sorted(servers.items()) if isinstance(v, dict)], whole


def _read_hooks_and_scripts(rep, root, rest):
    """Judge the pack's hook fragments and scripts outside its skill directories by the rules
    plugin_scan.py applies to a plugin's hooks and scripts; return the files still unread.

    A fragment is a `*.json` in Claude Code settings shape (`{"hooks": {"<Event>": [{"matcher",
    "hooks": [{"command"}]}]}}`) or a map of entries carrying `event` and `handler.command`
    (kit-research `humanmaxxing-vs-kit`). A JSON file in neither shape stays declared unread."""
    plugin = _plugin_scan()
    left, entries, scripts = [], 0, 0
    for rel in rest:
        is_json, text, hooks, state = _classify_rest_file(root, rel)
        if state == "read":
            continue  # a Claude Code settings file with no hooks: read, nothing to judge
        if state == "unread":
            left.append(rel)
            continue
        _secrets_in(rep, rel, text)
        if not is_json:
            plugin._scan_script(rep, rel, text)
            scripts += 1
            continue
        entries += len(hooks)
        for event, matcher, command in hooks:
            plugin._judge_hook(rep, rel, event, matcher)
            plugin._scan_script(rep, f"{rel} {event} command", command)
    if entries or scripts:
        rep.fact(f"read {entries} hook entr{'y' if entries == 1 else 'ies'} and {scripts} script(s) outside the skill directories")
    return left


def _classify_rest_file(root, rel):
    """Read one file outside the skill directories: (is_json, text, hooks, state), where state
    is "read" (a settings file with no hooks), "unread" (unreadable, or JSON in no hook shape)
    or "judge"."""
    is_json = rel.endswith(".json")
    text = _read_text(os.path.join(root, *rel.split("/"))) if is_json or rel.endswith(_HOOK_SCRIPTS) else None
    hooks = _hook_entries(text) if is_json and text is not None else []
    if is_json and not hooks and _is_settings_object(rel, text):
        return is_json, text, hooks, "read"
    if text is None or (is_json and not hooks):
        return is_json, text, hooks, "unread"
    return is_json, text, hooks, "judge"


def _is_settings_object(rel, text):
    """A Claude Code `settings.json` / `settings.local.json` that parses to an object."""
    if text is None or os.path.basename(rel) not in ("settings.json", "settings.local.json"):
        return False
    try:
        return isinstance(json.loads(text), dict)
    except ValueError:
        return False


def _read_text(full):
    try:
        if os.path.islink(full) or os.path.getsize(full) > FILE_LIMIT:
            return None
        with open(full, "r", encoding="utf-8") as f:
            return f.read()
    except (OSError, UnicodeDecodeError):
        return None


def _hook_entries(text):
    """(event, matcher, command) for each hook command in a settings-shaped or fragment JSON."""
    try:
        data = json.loads(text)
    except ValueError:
        return []
    if not isinstance(data, dict):
        return []
    return _settings_hooks(data.get("hooks")) + _fragment_hooks(data)


def _settings_hooks(events):
    """Claude Code settings shape: {"<Event>": [{"matcher", "hooks": [{"command"}]}]}."""
    out = []
    for event, groups in (events.items() if isinstance(events, dict) else ()):
        for group in groups if isinstance(groups, list) else ():
            hooks = group.get("hooks") if isinstance(group, dict) else None
            if not isinstance(hooks, list):
                continue
            matcher = str(group.get("matcher", "*"))
            out += [(str(event), matcher, str(h.get("command", ""))) for h in hooks if isinstance(h, dict)]
    return out


def _fragment_hooks(data):
    """Fragment shape: {"<name>": {"event", "matcher", "handler": {"command"}}}."""
    out = []
    for entry in data.values():
        handler = entry.get("handler") if isinstance(entry, dict) else None
        if isinstance(handler, dict) and isinstance(entry.get("event"), str) and "command" in handler:
            out.append((entry["event"], str(entry.get("matcher", "*")), str(handler["command"])))
    return out


def _skills_under(root):
    """Every SKILL.md up to SKILL_PACK_DEPTH levels below `root`, in a stable order."""
    found = []
    base = root.rstrip("/\\").count(os.sep)
    for current, dirs, files in os.walk(root):
        dirs[:] = sorted(d for d in dirs if d not in (".git", "node_modules"))
        if current.count(os.sep) - base >= SKILL_PACK_DEPTH:
            dirs[:] = []
        if current != root and "SKILL.md" in files:
            found.append(os.path.join(current, "SKILL.md"))
    return found


def _triage_skill_file(rep, path, scan_dir, label):
    """Frontmatter, secrets and instruction rules of one SKILL.md, the files it names, and its
    directory's other files when `scan_dir`."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            text = f.read()
    except OSError as e:
        rep.critical(f"{label}cannot read skill at '{path}': {e}")
        return
    keys = _frontmatter_keys(text)
    if keys is None:
        rep.critical(f"{label}SKILL.md has no YAML frontmatter (--- ... ---)")
        keys = set()
    if "name" not in keys:
        rep.warn(f"{label}frontmatter missing 'name:'")
    if "description" not in keys:
        rep.warn(f"{label}frontmatter missing 'description:'")
    _secrets_in(rep, f"{label}skill body", text)
    _plugin_scan().frontmatter_hooks(rep, f"{label}SKILL.md", text)
    _render_time_commands(rep, f"{label}SKILL.md", text)
    signals = {"conceal": _conceal_lines(rep, f"{label}SKILL.md", text), "credential-payload": []}
    _named_files(rep, os.path.dirname(path), text, scan_dir, label)
    if scan_dir:
        _scan_other_files(rep, os.path.dirname(path), path, label, signals)
    _concealed_credential_payload(rep, signals, label)
    rep.fact(f"validated local skill at {path} ({len(text)} bytes)")


# Claude Code runs `!`<command>`` in a SKILL.md (and in a custom slash command) through the shell
# when the skill is loaded, and puts the command's output where it stood: the command runs before
# the model reads the skill, and the model sees only its output. kit knows no other harness that
# does this: OpenAI Codex and other readers of SKILL.md document no such step and hand the line to
# the model as text. Every `!`...`` span is read, inside code fences too: whether a harness skips
# fences is not something kit can verify here.
RENDER_CMD = re.compile(r"!`([^`\n]+)`")
_RENDER_NET = re.compile(r"\b(?:curl|wget|nc|ncat|ssh|scp|rsync|ftp|telnet|Invoke-WebRequest|"
                         r"Invoke-RestMethod|iwr|irm)\b|https?://|/dev/(?:tcp|udp)/", re.I)
_RENDER_SECRET = re.compile(r"\$\{?[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|KEY|CREDENTIAL)|\bprintenv\b|"
                            r"(?:^|[;&|]\s*)env\s*(?:$|[|>;&])|\.env\b|\.ssh/|\.aws/|\.netrc|\.npmrc|"
                            r"\.pypirc|\bcredentials\b|\bsecurity\s+find-")


def _render_reach(plugin, cmd):
    """What a render-time command reaches that fails the skill, or None."""
    if any(p.search(cmd) for p in plugin.PIPE_TO_SHELL) or plugin.RUNNER.search(cmd):
        return "runs downloaded code"
    if _RENDER_SECRET.search(cmd):
        return "reads a secret"
    return "reaches the network" if _RENDER_NET.search(cmd) else None


def _render_time_commands(rep, where, text):
    plugin = _plugin_scan()
    for n, line in enumerate(text.splitlines(), 1):
        for m in RENDER_CMD.finditer(line):
            cmd = m.group(1).strip()
            shown = cmd if len(cmd) <= 80 else cmd[:77] + "..."
            reach = _render_reach(plugin, cmd)
            what = f"{where}:{n}: render-time command `{shown}` runs when Claude Code loads the skill, before the model reads it"
            if reach:
                rep.critical(f"{what}, and it {reach}")
            else:
                rep.warn(what)


# Kept in step with CONCEAL and HIDE_ACTIVITY in src/instruction-scan-text.ts and
# src/instruction-rules.ts (`kit triage instructions`): a line telling the agent to keep something
# from its user. A line that forbids hiding ("never hide failures") has no `do not ... to the user`.
_WHO = r"(?:the\s+)?(?:user|human|operator|owner|reviewer)s?"
CONCEAL = re.compile(
    r"\b(?:never|don'?t|do not|without)\s+(?:tell(?:ing)?|inform(?:ing)?|notify(?:ing)?|alert(?:ing)?)\s+"
    + _WHO + r"\s+(?:about|that|of)\b"
    r"|\b(?:never|don'?t|do not|without)\s+(?:mention(?:ing)?|reveal(?:ing)?|show(?:ing)?)\s+(?:\S+\s+){0,4}to\s+"
    + _WHO + r"\b"
    r"|\b(?:hide|conceal|cover up)\s+(?:your|the|any|all)\s+(?:\w+\s+){0,2}(?:activity|actions|tracks|traces)\b",
    re.I)


def _conceal_lines(rep, where, text):
    """`file:line` of each line telling the agent to keep something from the user (each a warning)."""
    hits = [f"{where}:{n}" for n, line in enumerate(text.splitlines(), 1) if CONCEAL.search(line)]
    for at in hits:
        rep.warn(f"{at}: tells the agent to keep something from the user")
    return hits


def _concealed_credential_payload(rep, signals, label):
    """Each alone is a warning; together the skill hides a step from the user and ships the code
    that sends a credential away, which is what a credential-stealing skill looks like."""
    if signals["conceal"] and signals["credential-payload"]:
        rep.critical(f"{label}the skill tells the agent to keep a step from the user ({signals['conceal'][0]}) "
                     f"and ships a script that sends a credential over the network ({signals['credential-payload'][0]})")


# A file the skill bundles, as SKILL.md names it: a relative Markdown link, or a path that starts
# with ./ or one of the folders skills bundle files in. A bare `procedure.md` is not counted: it
# reads the same as a file of the user's project. URLs and `${VAR}/` prefixes are removed first.
_NAMED_LINK = re.compile(r"\]\(\s*<?([^)\s>]+)")
_NAMED_PATH = re.compile(r"(?<![\w./:-])((?:\./|(?:scripts|references|reference|assets|templates|"
                         r"examples|resources)/)[\w./-]*[\w-])")


def _named_paths(text):
    text = re.sub(r"\$?\{[^}\s]*\}/", "", re.sub(r"[A-Za-z][\w+.-]*://\S+", " ", text))
    out = []
    for m in _NAMED_LINK.finditer(text):
        target = re.split(r"[#?]", m.group(1), 1)[0]
        if target and ":" not in target and not target.startswith("/"):
            out.append(target)
    out += [m.group(1) for m in _NAMED_PATH.finditer(text)]
    return list(dict.fromkeys(p[2:] if p.startswith("./") else p for p in out))


def _named_files(rep, skill_dir, text, scan_dir, label):
    """A SKILL.md that tells the agent to read or run a file triage was not given is incomplete:
    the verdict covers less than the skill does (upstream labels it INCOMPLETE)."""
    base = os.path.realpath(skill_dir)
    missing, outside, unread = [], [], []
    for rel in _named_paths(text):
        full = os.path.join(skill_dir, *rel.split("/"))
        real = os.path.realpath(full)
        if real != base and not real.startswith(base + os.sep):
            outside.append(rel)
        elif not os.path.lexists(full):
            missing.append(rel)
        elif not scan_dir:
            unread.append(rel)
    for names, why in ((missing, "which is not there"), (outside, "outside the skill directory, not read"),
                       (unread, "not triaged: only SKILL.md was given; triage its directory")):
        if names:
            more = f" and {len(names) - 10} more" if len(names) > 10 else ""
            rep.warn(f"{label}SKILL.md names {', '.join(names[:10])}{more}, {why} -- the verdict does not cover it")


def _secrets_in(rep, label, text):
    for kind, pattern in SECRET_PATTERNS:
        if pattern.search(text):
            rep.critical(f"possible secret in {label}: {kind}")


def _scan_other_files(rep, skill_dir, skill_md, label="", signals=None):
    """A skill's scripts are its code: a verdict that read only the prose would pass a skill
    whose script was never opened. Markdown files get the instruction rules SKILL.md gets, other
    text files the line rules plugin_scan.py applies to a plugin's scripts. Files that cannot be
    read as text are named, not skipped."""
    signals = signals if signals is not None else {"conceal": [], "credential-payload": []}
    plugin = _plugin_scan()
    read, unread = 0, []
    for root, dirs, files in os.walk(skill_dir):
        dirs[:] = sorted(d for d in dirs if d != ".git")
        for name in sorted(files):
            full = os.path.join(root, name)
            if full == skill_md:
                continue
            rel = os.path.relpath(full, skill_dir).replace(os.sep, "/")  # same report on Windows
            body = _read_text(full)
            if body is None:
                unread.append(rel)
                continue
            read += 1
            _judge_skill_file(rep, plugin, f"{label}{rel}", body, signals)
    rep.fact(f"{label}scanned {read} other file(s) in the skill directory")
    if unread:
        more = f" and {len(unread) - 10} more" if len(unread) > 10 else ""
        rep.warn(f"{label}not scanned (binary, symlink or over 1 MB): {', '.join(unread[:10])}{more}")


def _judge_skill_file(rep, plugin, where, body, signals):
    _secrets_in(rep, where, body)
    if where.endswith(".md"):
        signals["conceal"] += _conceal_lines(rep, where, body)
    elif not where.endswith(".json") and "credential-payload" in plugin._scan_script(rep, where, body):
        signals["credential-payload"].append(where)
