"""Gate tests for tracked links, submodules and unsafe ignore files."""

import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import unittest

from semgrep_gate_fixtures import GATE, RULE, clean_report


@unittest.skipIf(os.name == "nt", "Semgrep CI fixtures require a POSIX environment")
class TrackedSymlinkTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="kit-semgrep-git-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.rule = self.root / "rule.yml"
        self.rule.write_text(RULE, encoding="utf-8")
        self.env = {
            "PATH": os.environ.get("PATH", os.defpath),
            "HOME": str(self.root),
            "SEMGREP_SEND_METRICS": "off",
            "SEMGREP_ENABLE_VERSION_CHECK": "0",
        }
        self.git("init", "-q")
        (self.repo / "clean.js").write_text("const x = 1;\n", encoding="utf-8")
        self.git("add", "--all")

    def git(self, *args, input_bytes=None):
        return subprocess.run(
            ["git", *args], cwd=self.repo, env=self.env, input=input_bytes,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True,
        )

    def run_gate(self):
        return subprocess.run(
            [sys.executable, str(GATE), "--config", str(self.rule), "."],
            cwd=self.repo, env=self.env, stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT, text=True, timeout=120,
        )

    def use_clean_semgrep_shim(self, report=None):
        fakebin = self.root / "fakebin"
        fakebin.mkdir(exist_ok=True)
        scanner = fakebin / "semgrep"
        scanner.write_text(
            "#!/bin/sh\nprintf '%s\\n' " + shlex.quote(json.dumps(clean_report() if report is None else report)) + "\n",
            encoding="utf-8",
        )
        scanner.chmod(0o755)
        self.env["PATH"] = str(fakebin) + os.pathsep + self.env["PATH"]
        return fakebin

    def test_tracked_regular_file_passes(self):
        result = self.run_gate()
        self.assertEqual(result.returncode, 0, result.stdout)

    def test_tracked_link_to_source_fails(self):
        (self.repo / "link.js").symlink_to("clean.js")
        self.git("add", "--", "link.js")
        result = self.run_gate()
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("link.js", result.stdout)
        self.assertIn("Semgrep did not explicitly ignore tracked symbolic link", result.stdout)

    def test_tracked_broken_link_fails(self):
        (self.repo / "broken.js").symlink_to("missing.js")
        self.git("add", "--", "broken.js")
        result = self.run_gate()
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("broken.js", result.stdout)
        self.assertIn("Semgrep did not explicitly ignore tracked symbolic link", result.stdout)

    def test_ignored_tracked_link_passes(self):
        (self.repo / "link.js").symlink_to("clean.js")
        (self.repo / ".semgrepignore").write_text("link.js\n", encoding="utf-8")
        self.git("add", "--all")
        result = self.run_gate()
        self.assertEqual(result.returncode, 0, result.stdout)

    def assert_include_hides_finding_without_gate(self):
        result = subprocess.run(
            ["semgrep", "scan", "--json", "--strict", "--error", "--metrics=off",
             "--verbose", "--time", "--max-target-bytes", "1000000",
             "--config", str(self.rule), "."],
            cwd=self.repo, env=self.env, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, timeout=120,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        self.assertEqual(report["results"], [])
        self.assertIn("clean.js", report["paths"]["scanned"])
        self.assertNotIn("bad.js", report["paths"]["scanned"])

    def test_external_include_stops_scanner(self):
        (self.repo / "bad.js").write_text("dangerous(1);\n", encoding="utf-8")
        (self.root / "outside-ignore").write_text("bad.js\n", encoding="utf-8")
        (self.repo / ".semgrepignore").write_text(" \t:include../outside-ignore\r\n", encoding="utf-8")
        self.git("add", "--all")
        self.assert_include_hides_finding_without_gate()
        sentinel = self.use_semgrep_sentinel()
        result = self.run_gate()
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("unsupported :include", result.stdout)
        self.assertFalse(sentinel.exists(), "Semgrep must not read the external ignore file")

    def test_symlink_include_stops_scanner(self):
        (self.repo / "bad.js").write_text("dangerous(1);\n", encoding="utf-8")
        outside = self.root / "outside-ignore"
        outside.write_text("bad.js\n", encoding="utf-8")
        (self.repo / "linked-ignore").symlink_to(outside)
        (self.repo / ".semgrepignore").write_text(":include linked-ignore\n", encoding="utf-8")
        self.git("add", "--", "bad.js", ".semgrepignore")
        self.assert_include_hides_finding_without_gate()
        sentinel = self.use_semgrep_sentinel()
        result = self.run_gate()
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("unsupported :include", result.stdout)
        self.assertFalse(sentinel.exists(), "Semgrep must not read the linked ignore file")

    def test_nested_include_stops_scanner(self):
        directory = self.repo / "nested"
        directory.mkdir()
        (directory / ".semgrepignore").write_text(":include ../../outside-ignore\n", encoding="utf-8")
        sentinel = self.use_semgrep_sentinel()
        result = self.run_gate()
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("unsupported :include", result.stdout)
        self.assertFalse(sentinel.exists(), "Semgrep must not read a nested include")

    def test_regular_ignore_and_commented_include_pass(self):
        (self.repo / "bad.js").write_text("dangerous(1);\n", encoding="utf-8")
        (self.repo / ".semgrepignore").write_text(
            "# :include ../outside-ignore\n  # :include linked-ignore\nbad.js\n", encoding="utf-8"
        )
        self.git("add", "--all")
        result = self.run_gate()
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertIn("0 findings", result.stdout)

    def test_fifo_ignore_stops_before_scanner_without_blocking(self):
        os.mkfifo(self.repo / ".semgrepignore")
        sentinel = self.use_semgrep_sentinel()
        result = subprocess.run(
            [sys.executable, str(GATE), "--config", str(self.rule), "."],
            cwd=self.repo, env=self.env, stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT, text=True, timeout=5,
        )
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("unsafe ignore file", result.stdout)
        self.assertFalse(sentinel.exists(), "Semgrep must not read a FIFO ignore file")

    def test_linked_semgrepignore_stops_scanner_before_read(self):
        outside = self.root / "outside-ignore"
        outside.write_text(".semgrepignore\nclean.js\n", encoding="utf-8")
        (self.repo / ".semgrepignore").symlink_to(outside)
        self.git("add", "--", ".semgrepignore")
        sentinel = self.use_semgrep_sentinel()
        result = self.run_gate()
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertFalse(sentinel.exists(), "Semgrep must not read a linked ignore file")

    def test_untracked_linked_semgrepignore_stops_scanner_before_read(self):
        outside = self.root / "outside-ignore"
        outside.write_text("clean.js\n", encoding="utf-8")
        (self.repo / ".semgrepignore").symlink_to(outside)
        sentinel = self.use_semgrep_sentinel()
        result = self.run_gate()
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertFalse(sentinel.exists(), "Semgrep must not read an untracked linked ignore file")

    def test_linked_gitignore_stops_scanner_before_read(self):
        outside = self.root / "outside-gitignore"
        outside.write_text("clean.js\n", encoding="utf-8")
        (self.repo / ".gitignore").symlink_to(outside)
        sentinel = self.use_semgrep_sentinel()
        result = self.run_gate()
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertFalse(sentinel.exists(), "Semgrep must not read a linked Git ignore file")

    def test_nested_linked_ignore_stops_scanner_before_read(self):
        directory = self.repo / "src"
        directory.mkdir()
        (directory / "safe.js").write_text("const y = 1;\n", encoding="utf-8")
        self.git("add", "--", "src/safe.js")
        outside = self.root / "outside-ignore"
        outside.write_text("safe.js\n", encoding="utf-8")
        (directory / ".semgrepignore").symlink_to(outside)
        sentinel = self.use_semgrep_sentinel()
        result = self.run_gate()
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertFalse(sentinel.exists(), "Semgrep must not read a nested linked ignore file")

    def test_untracked_nested_linked_ignore_stops_scanner_before_read(self):
        directory = self.repo / "untracked"
        directory.mkdir()
        (directory / "source.js").write_text("dangerous(1);\n", encoding="utf-8")
        outside = self.root / "outside-ignore"
        outside.write_text("source.js\n", encoding="utf-8")
        (directory / ".semgrepignore").symlink_to(outside)
        sentinel = self.use_semgrep_sentinel()
        result = self.run_gate()
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertFalse(sentinel.exists(), "Semgrep must not read a linked ignore in an untracked directory")

    def test_gitignored_nested_linked_ignore_stops_scanner_before_read(self):
        (self.repo / ".gitignore").write_text("ignored/\n", encoding="utf-8")
        self.git("add", "--", ".gitignore")
        directory = self.repo / "ignored"
        directory.mkdir()
        (directory / "source.js").write_text("dangerous(1);\n", encoding="utf-8")
        outside = self.root / "outside-ignore"
        outside.write_text("source.js\n", encoding="utf-8")
        (directory / ".semgrepignore").symlink_to(outside)
        sentinel = self.use_semgrep_sentinel()
        result = self.run_gate()
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertFalse(sentinel.exists(), "Semgrep must not read a linked ignore in an ignored directory")

    def test_external_link_fails_without_reading_target(self):
        external = self.root / "external.js"
        external.write_text("dangerous(1);\n", encoding="utf-8")
        external.chmod(0)
        self.addCleanup(external.chmod, 0o600)
        (self.repo / "external.js").symlink_to(external)
        self.git("add", "--", "external.js")
        result = self.run_gate()
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("external.js", result.stdout)
        self.assertIn("Semgrep did not explicitly ignore tracked symbolic link", result.stdout)
        self.assertNotIn("dangerous(1)", result.stdout)

    def test_tracked_directory_link_does_not_scan_external_files(self):
        outside = self.root / "outside"
        outside.mkdir()
        (outside / "file.js").write_text("dangerous(1);\n", encoding="utf-8")
        (self.repo / "external-dir").symlink_to(outside, target_is_directory=True)
        self.git("add", "--", "external-dir")
        result = self.run_gate()
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("external-dir", result.stdout)
        self.assertNotIn("dangerous(1)", result.stdout)
        self.assertNotIn(str(outside / "file.js"), result.stdout)
        self.assertIn("0 findings", result.stdout)

    def test_gitignored_tracked_link_needs_semgrepignore(self):
        (self.repo / "link.js").symlink_to("clean.js")
        (self.repo / ".gitignore").write_text("link.js\n", encoding="utf-8")
        self.git("add", "--all")
        self.git("add", "-f", "--", "link.js")
        result = self.run_gate()
        self.assertNotEqual(result.returncode, 0, result.stdout)
        (self.repo / ".semgrepignore").write_text("link.js\n", encoding="utf-8")
        self.git("add", "--", ".semgrepignore")
        result = self.run_gate()
        self.assertEqual(result.returncode, 0, result.stdout)

    def test_unstaged_file_to_symlink_fails(self):
        (self.repo / "safe.js").write_text("const y = 1;\n", encoding="utf-8")
        self.git("add", "--", "safe.js")
        (self.repo / "clean.js").unlink()
        (self.repo / "clean.js").symlink_to(self.root / "external.js")
        result = self.run_gate()
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("clean.js", result.stdout)

    def use_semgrep_sentinel(self):
        fakebin = self.root / "sentinel-bin"
        fakebin.mkdir()
        sentinel = self.root / "semgrep-was-run"
        self.env["SEMGREP_TEST_SENTINEL"] = str(sentinel)
        scanner = fakebin / "semgrep"
        scanner.write_text(
            "#!/bin/sh\n: > \"$SEMGREP_TEST_SENTINEL\"\nprintf '%s\\n' "
            + shlex.quote(json.dumps(clean_report())) + "\n",
            encoding="utf-8",
        )
        scanner.chmod(0o755)
        self.env["PATH"] = str(fakebin) + os.pathsep + self.env["PATH"]
        return sentinel

    def test_unstaged_directory_symlink_fails_before_scan(self):
        directory = self.repo / "src"
        directory.mkdir()
        (directory / "file.js").write_text("const x = 1;\n", encoding="utf-8")
        self.git("add", "--all")
        (directory / "file.js").unlink()
        directory.rmdir()
        outside = self.root / "outside"
        outside.mkdir()
        (outside / "file.js").write_text("dangerous(1);\n", encoding="utf-8")
        directory.symlink_to(outside, target_is_directory=True)
        sentinel = self.use_semgrep_sentinel()
        result = self.run_gate()
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertFalse(sentinel.exists(), "Semgrep must not read through a modified directory link")

    def test_assume_unchanged_file_to_symlink_fails_before_scan(self):
        self.git("update-index", "--assume-unchanged", "--", "clean.js")
        (self.repo / "clean.js").unlink()
        (self.repo / "clean.js").symlink_to(self.root / "external.js")
        sentinel = self.use_semgrep_sentinel()
        result = self.run_gate()
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertFalse(sentinel.exists(), "Semgrep must not run before detecting a type change")

    def test_missing_tracked_file_fails(self):
        (self.repo / "safe.js").write_text("const y = 1;\n", encoding="utf-8")
        self.git("add", "--", "safe.js")
        (self.repo / "clean.js").unlink()
        result = self.run_gate()
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("clean.js", result.stdout)

    def test_tracked_gitlink_fails(self):
        self.git("update-index", "--add", "--cacheinfo", "160000," + "1" * 40 + ",vendor")
        result = self.run_gate()
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("vendor", result.stdout)

    def test_gitlink_replaced_by_external_symlink_fails_before_scan(self):
        self.git("update-index", "--add", "--cacheinfo", "160000," + "1" * 40 + ",vendor")
        outside = self.root / "outside"
        outside.mkdir()
        (outside / "file.js").write_text("dangerous(1);\n", encoding="utf-8")
        (self.repo / "vendor").symlink_to(outside, target_is_directory=True)
        sentinel = self.use_semgrep_sentinel()
        result = self.run_gate()
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("vendor", result.stdout)
        self.assertFalse(sentinel.exists(), "Semgrep must not run through a modified gitlink")

    def test_explicitly_reported_ignored_gitlink_passes(self):
        self.git("update-index", "--add", "--cacheinfo", "160000," + "1" * 40 + ",vendor")
        report = clean_report()
        report["paths"]["skipped"] = [{"path": "vendor", "reason": "semgrepignore_patterns_match"}]
        self.use_clean_semgrep_shim(report)
        result = self.run_gate()
        self.assertEqual(result.returncode, 0, result.stdout)

    def test_tracked_links_with_special_names_fail(self):
        for name in ("space link.js", "tab\tlink.js", "newline\nlink.js"):
            with self.subTest(name=name):
                (self.repo / name).symlink_to("clean.js")
                self.git("add", "--", name)
                result = self.run_gate()
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertIn("Semgrep did not explicitly ignore tracked symbolic link", result.stdout)
                self.assertIn(repr(name), result.stdout)
                (self.repo / name).unlink()
                self.git("add", "--all")

    def test_git_failure_fails_closed(self):
        fakebin = self.use_clean_semgrep_shim()
        fakegit = fakebin / "git"
        fakegit.write_text("#!/bin/sh\nexit 42\n", encoding="utf-8")
        fakegit.chmod(0o755)
        result = self.run_gate()
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("Cannot verify tracked symbolic links", result.stdout)

    def test_unmerged_index_fails_closed(self):
        obj = self.git("hash-object", "-w", "--stdin", input_bytes=b"const x = 1;\n").stdout.strip()
        entries = b"".join(b"100644 " + obj + b" " + str(stage).encode() + b"\tconflict.js\n" for stage in (1, 2, 3))
        self.git("update-index", "--index-info", input_bytes=entries)
        self.use_clean_semgrep_shim()
        result = self.run_gate()
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("Git index has unresolved conflicts", result.stdout)
