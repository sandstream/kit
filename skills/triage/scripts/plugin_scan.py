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
# A download handed straight to a shell or PowerShell: whatever the server returns at hook time
# runs, unverified. `curl -o f` followed by a checksum check is not this, and is not matched.
_SHELL = r"(?:sudo\s+(?:-\S+\s+)*)?(?:ba|z|da|k)?sh(?![\w.-])"
PIPE_TO_SHELL = (
    # curl ... | sh, wget -qO- ... | sudo bash  (stops at the first pipe, so `||` never matches)
    re.compile(r"\b(?:curl|wget)\b[^\n|]*\|\s*" + _SHELL),
    # bash <(curl ...), source <(curl ...), . <(wget ...)
    re.compile(r"(?:\b(?:ba|z|da|k)?sh|\bsource|(?<![\w.])\.)\s+(?:-\S+\s+)*<\(\s*(?:curl|wget)\b"),
    # sh -c "$(curl ...)", eval "$(wget ...)", bash -c `curl ...`
    re.compile(r"(?:\b(?:ba|z|da|k)?sh\s+(?:-\w+\s+)*-c|\beval)\s+[\"']?(?:\$\(|`)\s*(?:curl|wget)\b"),
    # iex (iwr ...), Invoke-Expression (Invoke-WebRequest ...), iex ((New-Object Net.WebClient).DownloadString(...))
    re.compile(r"\b(?:iex|Invoke-Expression)\b[\s(&]*(?:iwr|irm|curl|wget|Invoke-WebRequest|Invoke-RestMethod|New-Object\s+(?:System\.)?Net\.WebClient)\b", re.I),
    # iwr ... | iex, irm ... | Invoke-Expression
    re.compile(r"\b(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod|DownloadString)\b[^\n|]*\|\s*(?:iex|Invoke-Expression)\b", re.I),
)
URL_HOST = re.compile(r"https?://([^/\s\"'`)$:?#]+)")


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
            if event == "modules":
                registered_modules = _report_modules(rep, plugin_dir, source, groups)
                rep.fact(f"plugin registers {registered_modules} hook module(s)")
                continue
            for group in groups if isinstance(groups, list) else []:
                matcher = str(group.get("matcher", "*")) if isinstance(group, dict) else "*"
                cmds = group.get("hooks", []) if isinstance(group, dict) else []
                registered += len(cmds) if isinstance(cmds, list) else 0
                _judge_hook(rep, source, event, matcher)
                _scan_hook_commands(rep, f"{source} {event} command", cmds)
    rep.fact(f"plugin registers {registered} hook command(s)")


# A Claude Code mod: hooks.json names JavaScript modules (`{"modules": ["./x.mjs"]}`) that Claude
# Code loads in its own process. The host reads `on("<event>", {tool: "<Tool>"}, ...)` from the
# source, so kit reads the same calls as text; it never runs the module.
MODULE_ON = re.compile(r"""\bon\(\s*["']([\w.]+)["']\s*(?:,\s*\{([^}]*)\})?""")
MODULE_TOOL = re.compile(r"""\btools?\s*:\s*(\[[^\]]*\]|["'][^"']+["'])""")
MODULE_PROCESS = re.compile(r"\$\.process\.run\s*\(")


def _module_tools(options):
    m = MODULE_TOOL.search(options or "")
    return re.findall(r"""["']([^"']+)["']""", m.group(1)) if m else []


def _report_modules(rep, plugin_dir, source, modules):
    """Each module of a mod: where it hooks in, read from its `on(...)` calls. A `tool.call` handler
    runs before the agent's tool call and can deny or rewrite it, as a PreToolUse hook can."""
    base = os.path.realpath(plugin_dir)
    hooks_dir = os.path.dirname(os.path.join(plugin_dir, source))
    count = 0
    for rel in modules if isinstance(modules, list) else []:
        if not isinstance(rel, str):
            continue
        full = os.path.realpath(os.path.join(hooks_dir, rel))
        label = os.path.relpath(full, base).replace(os.sep, "/")
        if not full.startswith(base + os.sep):
            rep.critical(f"hook module {rel} in {source} lies outside the plugin directory -- not read")
            continue
        try:
            with open(full, "r", encoding="utf-8") as f:
                text = f.read()
        except (OSError, UnicodeDecodeError):
            rep.warn(f"hook module {label} named in {source} could not be read -- not inspected")
            continue
        count += 1
        seen = set()
        for event, options in MODULE_ON.findall(text):
            key = (event, tuple(_module_tools(options)))
            if key in seen:
                continue
            seen.add(key)
            if event == "tool.call":
                tools = _module_tools(options)
                hit = [t for t in SENSITIVE_TOOLS if not tools or t in tools]
                scope = ", ".join(tools) if tools else "every tool"
                if hit:
                    rep.warn(f"{label}: tool.call hook on {scope} -- runs inside Claude Code before the agent's {', '.join(hit)} calls and can deny or rewrite them")
                else:
                    rep.fact(f"{label}: tool.call hook on {scope}")
            else:
                rep.fact(f"{label}: {event} hook")
        if MODULE_PROCESS.search(text):
            rep.fact(f"{label}: starts processes ($.process.run)")
    return count


def _scan_hook_commands(rep, label, cmds):
    """A hook's command text runs at hook time like a script, so it gets the same line scan."""
    for cmd in cmds if isinstance(cmds, list) else []:
        if isinstance(cmd, dict) and isinstance(cmd.get("command"), str):
            _scan_script(rep, label, cmd["command"])


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
        _pipe_to_shell(rep, f"{rel}:{n}", code)


def _pipe_to_shell(rep, where, code):
    m = next((m for m in (p.search(code) for p in PIPE_TO_SHELL) if m), None)
    if m:
        host = URL_HOST.search(code, m.start())
        src = f"from {host.group(1)}" if host else "from a remote URL"
        rep.warn(f"{where}: runs a script downloaded {src} without verifying it (download piped into a shell)")


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


def _mcp_servers(plugin_dir, manifest):
    """(source, name, server) for each MCP server a plugin registers: `.mcp.json` at its root, and
    `mcpServers` in plugin.json (inline, or a path to such a file)."""
    out = []
    declared = manifest.get("mcpServers")
    sources = [(".mcp.json", os.path.join(plugin_dir, ".mcp.json"))]
    if isinstance(declared, dict):
        out += [("plugin.json", n, v) for n, v in sorted(declared.items()) if isinstance(v, dict)]
    elif isinstance(declared, str):
        rel = declared[2:] if declared.startswith("./") else declared
        sources.append((rel, os.path.join(plugin_dir, *rel.split("/"))))
    for source, path in sources:
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, ValueError):
            continue
        servers = data.get("mcpServers", data) if isinstance(data, dict) else {}
        out += [(source, n, v) for n, v in sorted(servers.items()) if isinstance(v, dict)]
    return out


def _report_mcp_servers(rep, plugin_dir, manifest):
    """An MCP server a plugin registers starts with every session, like a hook. Its command was not
    reported at all (kit-research `fast-anything-vs-kit`: a plugin whose `.mcp.json` runs a binary
    from PATH read as "0 hook command(s)", PASSED)."""
    servers = _mcp_servers(plugin_dir, manifest)
    rep.fact(f"plugin registers {len(servers)} MCP server(s)")
    for source, name, server in servers:
        if isinstance(server.get("url"), str):
            host = URL_HOST.search(server["url"])
            rep.warn(f"{source}: MCP server {name!r} is remote ({host.group(1) if host else 'unparsed URL'}) -- its tools and their output come from that host")
            continue
        command = str(server.get("command", ""))
        args = [str(a) for a in server.get("args", [])] if isinstance(server.get("args"), list) else []
        line = " ".join([command] + args)
        _scan_script(rep, f"{source} MCP server {name!r}", line)
        local = command.startswith(("./", "${CLAUDE_PLUGIN_ROOT}", "$CLAUDE_PLUGIN_ROOT")) or any(
            "CLAUDE_PLUGIN_ROOT" in a for a in args)
        if RUNNER.search(line) or local:
            rep.fact(f"{source}: MCP server {name!r} runs `{line[:120]}`")
        else:
            rep.warn(f"{source}: MCP server {name!r} runs `{command}` from PATH on every session -- the plugin does not ship it; triage how that program is installed")


def triage_local_plugin(rep, secrets_in):
    """Triage a local Claude Code plugin directory (one with .claude-plugin/plugin.json)."""
    plugin_dir = rep.target
    manifest = _load_json(rep, os.path.join(plugin_dir, ".claude-plugin", "plugin.json"), "plugin.json")
    if isinstance(manifest, dict):
        rep.fact(f"plugin {manifest.get('name', '?')} {manifest.get('version', '')}".rstrip())
    _report_hooks(rep, plugin_dir, manifest or {})
    _report_mcp_servers(rep, plugin_dir, manifest or {})
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
