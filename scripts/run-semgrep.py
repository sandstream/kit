#!/usr/bin/env python3
"""Run the CI Semgrep scan and reject incomplete or unsuccessful output."""

import json
import os
import stat
import subprocess
import sys
import tempfile


def unreported_git_entries(skipped, env):
    """Check tracked entries and working-tree paths without following links."""
    root = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, check=True,
    ).stdout
    if not root.endswith(b"\n"):
        raise ValueError("Git did not report a repository root")
    root = os.fsdecode(root[:-1])
    if os.path.abspath(root) != os.getcwd():
        raise ValueError("run from the Git repository root")
    index = subprocess.run(
        ["git", "ls-files", "--stage", "--full-name", "-z"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, check=True,
    ).stdout
    if index and not index.endswith(b"\0"):
        raise ValueError("Git returned an incomplete index")
    ignored = {
        os.path.abspath(item["path"])
        for item in skipped
        if item.get("reason") in {"semgrepignore_patterns_match", "Gitignore_patterns_match"}
    }
    links = []
    submodules = []
    worktree_issues = []
    component_modes = {}
    for record in index.split(b"\0"):
        if not record:
            continue
        metadata, separator, path = record.partition(b"\t")
        fields = metadata.split(b" ")
        if not separator or not path or len(fields) != 3 or fields[2] not in (b"0", b"1", b"2", b"3"):
            raise ValueError("Git returned an invalid index entry")
        if fields[2] != b"0":
            raise ValueError("Git index has unresolved conflicts")
        if fields[0] not in (b"100644", b"100755", b"120000", b"160000"):
            raise ValueError("Git returned an unknown index mode")
        entry_mode = fields[0]
        if entry_mode in (b"120000", b"160000"):
            absolute = os.path.abspath(os.path.join(root, os.fsdecode(path)))
            if absolute not in ignored:
                entries = links if entry_mode == b"120000" else submodules
                entries.append(os.fsdecode(path))
        components = os.fsdecode(path).split("/")
        current = root
        for index, component in enumerate(components):
            current = os.path.join(current, component)
            if current not in component_modes:
                try:
                    component_modes[current] = os.lstat(current).st_mode
                except FileNotFoundError:
                    component_modes[current] = None
            mode = component_modes[current]
            is_last = index == len(components) - 1
            if mode is None:
                if entry_mode == b"160000":
                    break
                reason = "missing"
            elif stat.S_ISLNK(mode):
                if is_last and entry_mode == b"120000":
                    break
                reason = "symbolic link"
            elif is_last and entry_mode == b"120000":
                reason = "expected symbolic link"
            elif is_last and entry_mode == b"160000" and not stat.S_ISDIR(mode):
                reason = "expected submodule directory"
            elif (is_last and entry_mode != b"160000" and not stat.S_ISREG(mode)) or (not is_last and not stat.S_ISDIR(mode)):
                reason = "unexpected file type"
            else:
                continue
            if os.path.abspath(current) not in ignored:
                worktree_issues.append((os.fsdecode(path), reason))
            break

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


def main():
    if (
        len(sys.argv) != 4
        or sys.argv[1] != "--config"
        or sys.argv[2].startswith("-")
        or sys.argv[3] != "."
    ):
        print("Usage: run-semgrep.py --config RULESET .", file=sys.stderr)
        return 1
    env = os.environ.copy()
    for key in ("SEMGREP_APP_TOKEN", "SONAR_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "ACTIONS_RUNTIME_TOKEN"):
        env.pop(key, None)
    try:
        assert_safe_ignore_files(os.getcwd())
        _, _, preflight_issues = unreported_git_entries([], env)
    except (OSError, subprocess.CalledProcessError, ValueError) as error:
        print(f"Cannot verify tracked symbolic links and submodules: {error}", file=sys.stderr)
        return 1
    if preflight_issues:
        for path, reason in preflight_issues:
            print(f"Cannot verify tracked working-tree path {path!r}: {reason}", file=sys.stderr)
        return 1
    try:
        with tempfile.TemporaryDirectory(prefix="kit-semgrep-settings-") as settings_dir:
            env["SEMGREP_SETTINGS_FILE"] = os.path.join(settings_dir, "settings.yml")
            scan = subprocess.run(
                [
                    "semgrep", "scan", "--json", "--strict", "--error", "--metrics=off",
                    "--verbose", "--time", "--max-target-bytes", "1000000", *sys.argv[1:],
                ],
                stdout=subprocess.PIPE,
                env=env,
                text=True,
                check=False,
            )
    except OSError as error:
        print(f"Semgrep could not start: {error}", file=sys.stderr)
        return 1

    try:
        output = json.loads(scan.stdout)
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
        allowed = {"semgrepignore_patterns_match", "Gitignore_patterns_match"}
        unexpected_skips = []
        for item in skipped:
            if not isinstance(item, dict) or not isinstance(item.get("path"), str):
                raise ValueError("invalid skipped target")
            if item.get("reason") not in allowed:
                unexpected_skips.append(item)
    except (ValueError, TypeError, KeyError) as error:
        print(f"Semgrep output is incomplete or invalid: {error}", file=sys.stderr)
        return scan.returncode or 1

    try:
        symlinks, submodules, worktree_issues = unreported_git_entries(skipped, env)
    except (OSError, subprocess.CalledProcessError, ValueError) as error:
        print(f"Cannot verify tracked symbolic links and submodules: {error}", file=sys.stderr)
        return scan.returncode or 1

    for path in symlinks:
        print(f"Semgrep did not explicitly ignore tracked symbolic link: {path!r}", file=sys.stderr)
    for path in submodules:
        print(f"Semgrep did not explicitly ignore tracked submodule: {path!r}", file=sys.stderr)
    for path, reason in worktree_issues:
        print(f"Cannot verify tracked working-tree path {path!r}: {reason}", file=sys.stderr)
    for result in results:
        print(json.dumps(result, ensure_ascii=False), file=sys.stderr)
    for error in errors:
        print(json.dumps(error, ensure_ascii=False), file=sys.stderr)
    for item in unexpected_skips:
        print(f"Semgrep skipped a target: {json.dumps(item, ensure_ascii=False)}", file=sys.stderr)
    print(
        f"Semgrep reported {len(rules)} rule identifiers and {len(scanned)} scanned files: "
        f"{len(results)} findings, {len(errors)} errors, {len(unexpected_skips)} unexpected skips, "
        f"{len(symlinks)} unverified symbolic links, {len(submodules)} unverified submodules, "
        f"{len(worktree_issues)} unverified working-tree paths.",
        file=sys.stderr,
    )
    if scan.returncode or results or errors or unexpected_skips or symlinks or submodules or worktree_issues:
        return scan.returncode or 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
