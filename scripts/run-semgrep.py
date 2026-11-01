#!/usr/bin/env python3
"""Run the CI Semgrep scan and reject incomplete or unsuccessful output."""

import json
import os
import stat
import subprocess
import sys
import tempfile


IGNORED_REASONS = {"semgrepignore_patterns_match", "Gitignore_patterns_match"}


def git_output(args, env):
    return subprocess.run(
        ["git", *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, check=True,
    ).stdout


def repository_root(env):
    root = git_output(["rev-parse", "--show-toplevel"], env)
    if not root.endswith(b"\n"):
        raise ValueError("Git did not report a repository root")
    root = os.fsdecode(root[:-1])
    if os.path.abspath(root) != os.getcwd():
        raise ValueError("run from the Git repository root")
    return root


def parse_index_record(record):
    """Return (mode, path) for one `git ls-files --stage` record, or reject it."""
    metadata, separator, path = record.partition(b"\t")
    fields = metadata.split(b" ")
    if not separator or not path or len(fields) != 3 or fields[2] not in (b"0", b"1", b"2", b"3"):
        raise ValueError("Git returned an invalid index entry")
    if fields[2] != b"0":
        raise ValueError("Git index has unresolved conflicts")
    if fields[0] not in (b"100644", b"100755", b"120000", b"160000"):
        raise ValueError("Git returned an unknown index mode")
    return fields[0], path


def unexpected_type(is_last, mode, entry_mode):
    """Reason the filesystem type differs from what the index records, or None."""
    if not is_last:
        return None if stat.S_ISDIR(mode) else "unexpected file type"
    if entry_mode == b"120000":
        return "expected symbolic link"
    if entry_mode == b"160000":
        return None if stat.S_ISDIR(mode) else "expected submodule directory"
    return None if stat.S_ISREG(mode) else "unexpected file type"


def component_problem(position, last, mode, entry_mode):
    """Why one path component is unsafe to read, or None. Returns "stop" for a safe end."""
    is_last = position == last
    if mode is None:
        return "stop" if entry_mode == b"160000" else "missing"
    if stat.S_ISLNK(mode):
        return "stop" if is_last and entry_mode == b"120000" else "symbolic link"
    return unexpected_type(is_last, mode, entry_mode)


def worktree_problem(root, path, entry_mode, component_modes, ignored):
    """First unsafe component of a tracked path as (reason), honouring explicit ignores."""
    components = os.fsdecode(path).split("/")
    current = root
    for position, component in enumerate(components):
        current = os.path.join(current, component)
        if current not in component_modes:
            try:
                component_modes[current] = os.lstat(current).st_mode
            except FileNotFoundError:
                component_modes[current] = None
        reason = component_problem(position, len(components) - 1, component_modes[current], entry_mode)
        if reason is None:
            continue
        if reason == "stop" or os.path.abspath(current) in ignored:
            return None
        return reason
    return None


def unreported_git_entries(skipped, env):
    """Check tracked entries and working-tree paths without following links."""
    root = repository_root(env)
    index = git_output(["ls-files", "--stage", "--full-name", "-z"], env)
    if index and not index.endswith(b"\0"):
        raise ValueError("Git returned an incomplete index")
    ignored = {os.path.abspath(item["path"]) for item in skipped if item.get("reason") in IGNORED_REASONS}
    links = []
    submodules = []
    worktree_issues = []
    component_modes = {}
    for record in index.split(b"\0"):
        if not record:
            continue
        entry_mode, path = parse_index_record(record)
        if entry_mode in (b"120000", b"160000"):
            absolute = os.path.abspath(os.path.join(root, os.fsdecode(path)))
            if absolute not in ignored:
                (links if entry_mode == b"120000" else submodules).append(os.fsdecode(path))
        reason = worktree_problem(root, path, entry_mode, component_modes, ignored)
        if reason:
            worktree_issues.append((os.fsdecode(path), reason))
    return links, submodules, worktree_issues


def assert_safe_ignore_files(root):
    """Reject unsafe ignore files and Semgrep include directives."""
    pending = [root]
    while pending:
        directory = pending.pop()
        with os.scandir(directory) as entries:
            for entry in entries:
                if entry.name in (".semgrepignore", ".gitignore"):
                    if not stat.S_ISREG(entry.stat(follow_symlinks=False).st_mode):
                        raise ValueError(f"unsafe ignore file: {entry.path!r}")
                    if entry.name == ".semgrepignore":
                        # Do not follow a link or block on a FIFO if the path changes
                        # between the directory check and opening the file.
                        fd = os.open(entry.path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
                        with os.fdopen(fd, "rb") as ignore_file:
                            if not stat.S_ISREG(os.fstat(ignore_file.fileno()).st_mode):
                                raise ValueError(f"unsafe ignore file: {entry.path!r}")
                            for line in ignore_file:
                                if line.lstrip(b" \t").startswith(b":include"):
                                    raise ValueError(f"unsupported :include in ignore file: {entry.path!r}")
                elif entry.name != ".git" and entry.is_dir(follow_symlinks=False):
                    pending.append(entry.path)


SCAN_ARGS = [
    "semgrep", "scan", "--json", "--strict", "--error", "--metrics=off",
    "--verbose", "--time", "--max-target-bytes", "1000000",
]


def scrubbed_environment():
    env = os.environ.copy()
    for key in ("SEMGREP_APP_TOKEN", "SONAR_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "ACTIONS_RUNTIME_TOKEN"):
        env.pop(key, None)
    return env


def preflight(env):
    """Reject unsafe ignore files and unverifiable tracked paths before scanning. 0 means go."""
    try:
        assert_safe_ignore_files(os.getcwd())
        _, _, issues = unreported_git_entries([], env)
    except (OSError, subprocess.CalledProcessError, ValueError) as error:
        print(f"Cannot verify tracked symbolic links and submodules: {error}", file=sys.stderr)
        return 1
    for path, reason in issues:
        print(f"Cannot verify tracked working-tree path {path!r}: {reason}", file=sys.stderr)
    return 1 if issues else 0


def run_scan(env):
    with tempfile.TemporaryDirectory(prefix="kit-semgrep-settings-") as settings_dir:
        env["SEMGREP_SETTINGS_FILE"] = os.path.join(settings_dir, "settings.yml")
        return subprocess.run(
            [*SCAN_ARGS, *sys.argv[1:]], stdout=subprocess.PIPE, env=env, text=True, check=False,
        )


def parse_scan(stdout):
    """Validate Semgrep's JSON. Returns the parts the report needs, or raises ValueError."""
    output = json.loads(stdout)
    results = output["results"]
    errors = output["errors"]
    scanned = output["paths"]["scanned"]
    skipped = output["paths"]["skipped"]
    rules = output["time"]["rules"]
    if not all(isinstance(value, list) for value in (results, errors, scanned, skipped, rules)):
        raise ValueError("results, errors, scanned, skipped and rules must be lists")
    if not scanned:
        raise ValueError("Semgrep reported no scanned files")
    if not rules or not all(isinstance(rule, str) and rule for rule in rules):
        raise ValueError("Semgrep reported no valid rules")
    unexpected_skips = []
    for item in skipped:
        if not isinstance(item, dict) or not isinstance(item.get("path"), str):
            raise ValueError("invalid skipped target")
        if item.get("reason") not in IGNORED_REASONS:
            unexpected_skips.append(item)
    return results, errors, scanned, skipped, rules, unexpected_skips


def dump(item):
    return json.dumps(item, ensure_ascii=False)


def report(scan, parsed, git_entries):
    results, errors, scanned, _, rules, unexpected_skips = parsed
    symlinks, submodules, worktree_issues = git_entries
    for path in symlinks:
        print(f"Semgrep did not explicitly ignore tracked symbolic link: {path!r}", file=sys.stderr)
    for path in submodules:
        print(f"Semgrep did not explicitly ignore tracked submodule: {path!r}", file=sys.stderr)
    for path, reason in worktree_issues:
        print(f"Cannot verify tracked working-tree path {path!r}: {reason}", file=sys.stderr)
    for result in results:
        print(dump(result), file=sys.stderr)
    for error in errors:
        print(dump(error), file=sys.stderr)
    for item in unexpected_skips:
        print(f"Semgrep skipped a target: {dump(item)}", file=sys.stderr)
    print(
        f"Semgrep reported {len(rules)} rule identifiers and {len(scanned)} scanned files: "
        f"{len(results)} findings, {len(errors)} errors, {len(unexpected_skips)} unexpected skips, "
        f"{len(symlinks)} unverified symbolic links, {len(submodules)} unverified submodules, "
        f"{len(worktree_issues)} unverified working-tree paths.",
        file=sys.stderr,
    )
    failed = results or errors or unexpected_skips or symlinks or submodules or worktree_issues
    return (scan.returncode or 1) if scan.returncode or failed else 0


def main():
    if (
        len(sys.argv) != 4
        or sys.argv[1] != "--config"
        or sys.argv[2].startswith("-")
        or sys.argv[3] != "."
    ):
        print("Usage: run-semgrep.py --config RULESET .", file=sys.stderr)
        return 1
    env = scrubbed_environment()
    if preflight(env):
        return 1
    try:
        scan = run_scan(env)
    except OSError as error:
        print(f"Semgrep could not start: {error}", file=sys.stderr)
        return 1
    try:
        parsed = parse_scan(scan.stdout)
    except (ValueError, TypeError, KeyError) as error:
        print(f"Semgrep output is incomplete or invalid: {error}", file=sys.stderr)
        return scan.returncode or 1
    try:
        git_entries = unreported_git_entries(parsed[3], env)
    except (OSError, subprocess.CalledProcessError, ValueError) as error:
        print(f"Cannot verify tracked symbolic links and submodules: {error}", file=sys.stderr)
        return scan.returncode or 1
    return report(scan, parsed, git_entries)


if __name__ == "__main__":
    sys.exit(main())
