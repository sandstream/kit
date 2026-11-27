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
# A request whose body is a credential: `Request(url, data=token)`, `requests.post(u, json={"token":
# t})`, `fetch(u, {body: secret})`, `curl -d "key=$API_TOKEN"`. A credential in a header is how an API
# is called and is not matched; one sent as the payload is the credential itself leaving the machine.
# Line scan: a payload built on an earlier line is not seen.
_CRED_NAME = r"\w*(?:token|secret|passw(?:or)?d|api_?key|credential)\w*"
CRED_PAYLOAD = (
    re.compile(r"(?:\bRequest|\burlopen|\brequests\.\w+|\bhttpx\.\w+|\bfetch|\baxios\.\w+|\.post|\.put)\s*\("
               r"[^\n]*\b(?:data|json|body|content)\s*[=:]\s*[^,\n]*\b" + _CRED_NAME, re.I),
    re.compile(r"\b(?:curl|wget)\b[^\n]*(?:\s-d|--data[\w-]*|\s-F|--form[\w-]*|--post-data)[=\s]+[\"']?[^\s\"']*"
               r"\$\{?[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|KEY|CREDENTIAL)"),
)


def _load_json(rep, path, label):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError) as e:
        rep.critical(f"cannot read {label}: {type(e).__name__}")
        return None


# Pinning per ecosystem; the twin of `pinned` in src/agent-audit-mcp-launch.ts, tested on the same
# launches (src/mcp-runner-pins.test-support.ts). kit-research `auto-ontology-vs-kit`: "a digit after
# the last @" called `uvx --from x==1.3.0` unpinned and a branch named `@2026-dev` pinned.
_PYPI_RUNNERS = ("uvx", "pipx run")
_SOURCE_OPTS = {"--from", "--package", "--spec"}
_VALUE_OPTS = {"--python", "--with", "--with-editable", "--with-requirements", "--index", "--index-url",
               "--extra-index-url", "--default-index", "--registry"}
_SEMVER = r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?"
_PEP440 = r"\d+(?:\.\d+)*(?:(?:a|b|rc)\d+)?(?:\.post\d+)?(?:\.dev\d+)?(?:\+[a-z0-9.]+)?"
_NPM_PIN = re.compile(r"(?:@[\w.-]+/)?[\w.-]+@" + _SEMVER)
_PYPI_PIN = re.compile(r"[A-Za-z0-9][\w.-]*(?:\[[\w,.-]*\])?(?:==|@)" + _PEP440, re.I)
_COMMIT = re.compile(r"[0-9a-f]{40}|[0-9a-f]{64}", re.I)
_GIT_SOURCE = re.compile(r"git\+|git://|^(?:github|gitlab|bitbucket):|://")
_ARG = re.compile(r"[^\s\"';|&)]+|[;|&)]")


def _runner_spec(runner, rest):
    """The package a runner starts, from the text after it: the value of `--from`, `--package` or
    `--spec` (`-p` for an npm runner) given before it, or its first operand. uv's `-p` and
    `--python` take a value that is not the package."""
    pypi = runner in _PYPI_RUNNERS
    args = []
    for tok in _ARG.findall(rest):
        if tok in ";|&)":
            break
        args.append(tok)
    i = 0
    while i < len(args):
        name, eq, val = args[i].partition("=")
        if not args[i].startswith("-"):
            return args[i]
        if name in _SOURCE_OPTS or (name == "-p" and not pypi):
            return val if eq else (args[i + 1] if i + 1 < len(args) else None)
        i += 2 if not eq and (name in _VALUE_OPTS or (name == "-p" and pypi)) else 1
    return None


def _git_source(spec, pypi):
    return bool(_GIT_SOURCE.search(spec)) or (not pypi and "#" in spec)


def _git_ref(spec, pypi):
    """The ref a git source names: after `#` for npm, after the last `@` of the URL path for uv/pip."""
    if not pypi:
        return spec.partition("#")[2]
    url = spec[spec.index("git+"):] if "git+" in spec else spec
    path = url.split("#", 1)[0].partition("://")[2]
    return path.rpartition("@")[2] if "@" in path else ""


def _pinned(spec, pypi=False):
    """True when a runner's package is pinned: npm `name@1.2.3` (an exact semver), PyPI `name==1.2.3`
    or uv's `name@1.2.3`, a git source by a full 40- or 64-hex commit. Anything else is unpinned."""
    if _git_source(spec, pypi):
        return bool(_COMMIT.fullmatch(_git_ref(spec, pypi)))
    return bool((_PYPI_PIN if pypi else _NPM_PIN).fullmatch(spec))


def _pin_advice(spec, pypi):
    if _git_source(spec, pypi):
        return f"pin a full commit ({'@' if pypi else '#'}<commit>)"
    return f"pin an exact version ({'name==1.2.3' if pypi else 'name@1.2.3'})"


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
    """Line-scan one script or command. Returns the kinds it found that a caller combines with other
    evidence ({"credential-payload"}); every finding is also reported here."""
    hits = set()
    for n, line in enumerate(text.splitlines(), 1):
        # A shell comment starts a word; `github:o/r#<commit>` keeps its ref.
        code = re.split(r"(?:^|\s)#", line, maxsplit=1)[0] if not line.lstrip().startswith("#!") else ""
        for m in RUNNER.finditer(code):
            runner = " ".join(m.group(1).split())
            spec = _runner_spec(runner, code[m.end(1):])
            pypi = runner in _PYPI_RUNNERS
            if spec and not spec.startswith("$") and not _pinned(spec, pypi):
                rep.warn(f"{rel}:{n}: `{runner} {spec}` runs the newest published version on every call "
                         f"(unpinned) -- {_pin_advice(spec, pypi)}")
        if UPLOAD.search(code):
            rep.warn(f"{rel}:{n}: uploads a local file's contents over the network")
        if any(p.search(code) for p in CRED_PAYLOAD):
            hits.add("credential-payload")
            rep.warn(f"{rel}:{n}: sends a credential as the body of a network request")
        _pipe_to_shell(rep, f"{rel}:{n}", code)
    return hits


def _pipe_to_shell(rep, where, code):
    m = next((m for m in (p.search(code) for p in PIPE_TO_SHELL) if m), None)
    if m:
        host = URL_HOST.search(code, m.start())
        src = f"from {host.group(1)}" if host else "from a remote URL"
        rep.warn(f"{where}: runs a script downloaded {src} without verifying it (download piped into a shell)")


def _frontmatter_block(text):
    """The lines between the opening and closing `---` of a SKILL.md, or []."""
    lines = text.replace("\r\n", "\n").split("\n")
    if not lines or lines[0].strip() != "---":
        return []
    for i, line in enumerate(lines[1:], 1):
        if line.strip() == "---":
            return lines[1:i]
    return []


def _indent(line):
    return len(line) - len(line.lstrip(" "))


def _frontmatter_hook_entries(block):
    """(event, matcher, command) for each hook a skill's frontmatter declares under `hooks:`.
    Read by indentation, as text: kit ships no YAML parser (ADR-0002)."""
    out, event, matcher, base = [], None, "*", None
    for line in block:
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if base is None:
            if re.match(r"^hooks\s*:\s*$", line):
                base = _indent(line)
            continue
        if _indent(line) <= base:
            break
        key = re.match(r"^\s*-?\s*([\w.-]+)\s*:\s*(.*)$", line)
        if not key:
            continue
        name, value = key.group(1), key.group(2).strip().strip("'\"")
        if not value and name[:1].isupper():  # an event key: PreToolUse, SessionStart …
            event, matcher = name, "*"
        elif name == "matcher":
            matcher = value or "*"
        elif name == "command" and event:
            out.append((event, matcher, value))
    return out


def frontmatter_hooks(rep, rel, text):
    """A skill can register hooks in its frontmatter that run while the skill is active
    (claude-plugins-official `claude-security` threat-model: PreToolUse on Write|Edit). They are
    judged as plugin hooks are; before this they were not read at all."""
    for event, matcher, command in _frontmatter_hook_entries(_frontmatter_block(text)):
        _judge_hook(rep, f"{rel} frontmatter", event, matcher)
        _scan_script(rep, f"{rel} frontmatter {event} command", command)


def _skill_name():
    """skill_name.py from this file's own directory, loaded by path, as skill_scan.py loads this one."""
    import importlib.util
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "skill_name.py")
    spec = importlib.util.spec_from_file_location("kit_skill_name", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _skill_frontmatter(rep, rel, text):
    frontmatter_hooks(rep, rel, text)
    _skill_name().judge(rep, f"{rel}: ", text, rel.split("/")[-2] if "/" in rel else "")
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
    seen = set()
    for source, path in sources:
        real = os.path.realpath(path)
        if real in seen:
            continue
        seen.add(real)
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, ValueError):
            continue
        servers = data.get("mcpServers", data) if isinstance(data, dict) else {}
        out += [(source, n, v) for n, v in sorted(servers.items()) if isinstance(v, dict)]
    return out


LOOPBACK = re.compile(r"^(localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)$", re.IGNORECASE)


def _report_mcp_url(rep, source, name, url):
    """An empty url is a placeholder the user fills in; a loopback host is a server on this machine,
    not a remote one. Everything else is remote: its tools and their output come from that host."""
    if not url.strip():
        rep.fact(f"{source}: MCP server {name!r} has an empty url (a placeholder) -- nothing connects until it is set")
        return
    host = URL_HOST.search(url)
    if host and LOOPBACK.match(host.group(1)):
        rep.fact(f"{source}: MCP server {name!r} is on this machine ({host.group(1)}) -- triage the program that serves it")
        return
    rep.warn(f"{source}: MCP server {name!r} is remote ({host.group(1) if host else 'unparsed URL'}) -- its tools and their output come from that host")


def _lsp_servers(plugin_dir, manifest):
    """(name, server) for each language server a plugin declares in `lspServers`, inline or as a
    path to a JSON file inside the plugin."""
    declared = manifest.get("lspServers")
    if isinstance(declared, str):
        rel = declared[2:] if declared.startswith("./") else declared
        path = os.path.realpath(os.path.join(plugin_dir, *rel.split("/")))
        if not path.startswith(os.path.realpath(plugin_dir) + os.sep):
            return []
        try:
            with open(path, "r", encoding="utf-8") as f:
                declared = json.load(f)
        except (OSError, ValueError):
            return []
    if not isinstance(declared, dict):
        return []
    return [(n, v) for n, v in sorted(declared.items()) if isinstance(v, dict)]


def _report_lsp_servers(rep, plugin_dir, manifest):
    """A language server starts when a matching file is opened, like an MCP server at session
    start. 12 official plugins start one from PATH and read as "0 MCP server(s)", 100/100."""
    servers = _lsp_servers(plugin_dir, manifest)
    if not servers:
        return
    rep.fact(f"plugin registers {len(servers)} LSP server(s)")
    for name, server in servers:
        command = str(server.get("command", ""))
        args = [str(a) for a in server.get("args", [])] if isinstance(server.get("args"), list) else []
        line = " ".join([command] + args)
        _scan_script(rep, f"LSP server {name!r}", line)
        if command.startswith(("./", "${CLAUDE_PLUGIN_ROOT}", "$CLAUDE_PLUGIN_ROOT")) or RUNNER.search(line):
            rep.fact(f"LSP server {name!r} runs `{line[:120]}`")
        else:
            rep.warn(f"LSP server {name!r} runs `{command}` from PATH when a matching file is opened -- the plugin does not ship it; triage how that program is installed")


def _report_mcp_servers(rep, plugin_dir, manifest):
    """An MCP server a plugin registers starts with every session, like a hook. Its command was not
    reported at all (kit-research `fast-anything-vs-kit`: a plugin whose `.mcp.json` runs a binary
    from PATH read as "0 hook command(s)", PASSED)."""
    servers = _mcp_servers(plugin_dir, manifest)
    rep.fact(f"plugin registers {len(servers)} MCP server(s)")
    for source, name, server in servers:
        judge_mcp_server(rep, source, name, server, "plugin")


def judge_mcp_server(rep, source, name, server, owner):
    """One MCP server entry (`url`, or `command` + `args`), registered by a plugin or a skill pack
    (`owner`): a remote host, an unpinned package runner, or a program run from PATH."""
    if isinstance(server.get("url"), str):
        _report_mcp_url(rep, source, name, server["url"])
        return
    command = str(server.get("command", ""))
    args = [str(a) for a in server.get("args", [])] if isinstance(server.get("args"), list) else []
    line = " ".join([command] + args)
    _scan_script(rep, f"{source} MCP server {name!r}", line)
    local = command.startswith(("./", "${CLAUDE_PLUGIN_ROOT}", "$CLAUDE_PLUGIN_ROOT")) or any(
        "CLAUDE_PLUGIN_ROOT" in a for a in args)
    if RUNNER.search(line) or local:
        rep.fact(f"{source}: MCP server {name!r} runs `{line[:120]}`")
    else:
        rep.warn(f"{source}: MCP server {name!r} runs `{command}` from PATH on every session -- the {owner} does not ship it; triage how that program is installed")


def _plugin_manifest(rep, plugin_dir, manifest):
    """The plugin's manifest: the one given (a `strict: false` marketplace entry) or plugin.json."""
    if manifest is None:
        manifest = _load_json(rep, os.path.join(plugin_dir, ".claude-plugin", "plugin.json"), "plugin.json")
    if isinstance(manifest, dict):
        rep.fact(f"plugin {manifest.get('name', '?')} {manifest.get('version', '')}".rstrip())
    return manifest


def triage_local_plugin(rep, secrets_in, manifest=None, roots=None):
    """Triage a local Claude Code plugin directory (one with .claude-plugin/plugin.json). A
    marketplace entry with `strict: false` is its own manifest (`manifest`), and when it lists its
    `skills` only those folders are walked (`roots`), not the whole marketplace."""
    plugin_dir = rep.target
    manifest = _plugin_manifest(rep, plugin_dir, manifest)
    _report_hooks(rep, plugin_dir, manifest or {})
    _report_mcp_servers(rep, plugin_dir, manifest or {})
    _report_lsp_servers(rep, plugin_dir, manifest or {})
    read, unread, skills = 0, [], 0
    for full in (f for r in (roots or [plugin_dir]) for f in _walk(r)):
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


class _InPlugin:
    """The report seen from one plugin of a marketplace: same lists, each line prefixed."""

    def __init__(self, rep, target, prefix):
        self._rep, self.target, self._prefix = rep, target, prefix

    def critical(self, m):
        self._rep.critical(self._prefix + m)

    def warn(self, m):
        self._rep.warn(self._prefix + m)

    def fact(self, m):
        self._rep.fact(self._prefix + m)


MARKETPLACE_LIMIT = 100


def _inside(base, full):
    return full == base or full.startswith(base + os.sep)


def _entry_skill_roots(rep, base, full, entry):
    """The skill folders a `strict: false` entry lists, each kept inside the marketplace."""
    roots = []
    for rel in entry.get("skills") or []:
        path = os.path.realpath(os.path.join(full, str(rel)))
        if _inside(base, path) and os.path.isdir(path):
            roots.append(path)
        else:
            rep.warn(f"plugin {entry.get('name', '?')!r}: skill {rel} is missing or outside the marketplace -- not read")
    return roots


def _marketplace_plugin(rep, base, entry, secrets_in):
    """Triage one marketplace entry whose source is a folder in the marketplace (`./` included)."""
    name = str(entry.get("name", "?"))
    full = os.path.realpath(os.path.join(base, entry["source"]))
    if not _inside(base, full):
        rep.critical(f"plugin {name!r}: source {entry['source']} lies outside the marketplace -- not read")
        return False
    view = _InPlugin(rep, full, f"{name}: ")
    if os.path.isfile(os.path.join(full, ".claude-plugin", "plugin.json")):
        triage_local_plugin(view, secrets_in)
        return True
    if entry.get("strict") is False:
        roots = _entry_skill_roots(rep, base, full, entry) if entry.get("skills") else None
        triage_local_plugin(view, secrets_in, manifest=entry, roots=roots)
        return True
    rep.warn(f"plugin {name!r}: {entry['source']} has no .claude-plugin/plugin.json and is not strict: false -- not triaged")
    return False


def _remote_summary(rep, remote):
    """One line for the entries kit does not fetch, by kind; a `command` source runs at install."""
    kinds = {}
    for entry in remote:
        src = entry.get("source")
        kind = str(src.get("source", "?")) if isinstance(src, dict) else type(src).__name__
        kinds.setdefault(kind, []).append(str(entry.get("name", "?")))
    for kind, names in sorted(kinds.items()):
        more = f" and {len(names) - 5} more" if len(names) > 5 else ""
        if kind == "command":
            rep.warn(f"{len(names)} plugin(s) are installed by running a command, not from a folder: {', '.join(names[:5])}{more} -- read that command before installing")
        else:
            rep.fact(f"{len(names)} plugin(s) come from a {kind} source kit does not fetch: {', '.join(names[:5])}{more} -- triage them on their own")


def triage_local_marketplace(rep, secrets_in):
    """Triage every local plugin a marketplace lists (`.claude-plugin/marketplace.json`). Without
    this a marketplace folder was triaged as a skill pack and failed with "no SKILL.md", although
    `claude plugin marketplace add ./` is how such a folder is installed."""
    base = os.path.realpath(rep.target)
    data = _load_json(rep, os.path.join(rep.target, ".claude-plugin", "marketplace.json"), "marketplace.json")
    plugins = data.get("plugins") if isinstance(data, dict) else None
    if not isinstance(plugins, list):
        if data is not None:
            rep.critical("marketplace.json lists no plugins")
        return
    entries = [p for p in plugins if isinstance(p, dict)]
    local = [e for e in entries if isinstance(e.get("source"), str)]
    remote = [e for e in entries if not isinstance(e.get("source"), str)]
    done = sum(_marketplace_plugin(rep, base, e, secrets_in) for e in local[:MARKETPLACE_LIMIT])
    if len(local) > MARKETPLACE_LIMIT:
        rep.warn(f"only the first {MARKETPLACE_LIMIT} of {len(local)} local plugins were triaged")
    _remote_summary(rep, remote)
    rep.fact(f"marketplace {data.get('name', '?')}: triaged {done} of {len(local)} local plugin(s); {len(remote)} from other sources")
