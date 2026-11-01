#!/usr/bin/env python3
"""Exercise the Semgrep gate with real scans and controlled scanner failures."""

import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import unittest


from semgrep_gate_fixtures import GATE, RULE, clean_report
from test_semgrep_gate_links import TrackedSymlinkTest  # noqa: F401  (discovered by unittest)


@unittest.skipIf(os.name == "nt", "Semgrep CI fixtures require a POSIX environment")
class SemgrepGateTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="kit-semgrep-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.target = self.root / "target"
        self.target.mkdir()
        self.rule = self.root / "rule.yml"
        self.rule.write_text(RULE, encoding="utf-8")
        (self.target / "clean.js").write_text("console.log(1);\n", encoding="utf-8")
        # Do not pass credentials or unrelated Semgrep settings to subprocesses.
        self.env = {
            "PATH": os.environ.get("PATH", os.defpath),
            "HOME": str(self.root),
            "SEMGREP_SEND_METRICS": "off",
            "SEMGREP_ENABLE_VERSION_CHECK": "0",
        }
        subprocess.run(["git", "init", "-q"], cwd=self.target, env=self.env, check=True)

    def run_gate(self):
        subprocess.run(["git", "add", "--all"], cwd=self.target, env=self.env, check=True)
        return subprocess.run(
            [sys.executable, str(GATE), "--config", str(self.rule), "."],
            cwd=self.target,
            env=self.env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            timeout=120,
        )

    def assert_status(self, result, succeeds):
        if succeeds:
            self.assertEqual(result.returncode, 0, result.stdout)
        else:
            self.assertNotEqual(result.returncode, 0, result.stdout)

    def use_shim(self, output, status):
        shim_dir = self.root / "bin"
        shim_dir.mkdir(exist_ok=True)
        shim = shim_dir / "semgrep"
        shim.write_text(
            "#!/bin/sh\nprintf '%s\\n' " + shlex.quote(output) + "\nexit " + str(status) + "\n",
            encoding="utf-8",
        )
        shim.chmod(0o755)
        self.env["PATH"] = str(shim_dir) + os.pathsep + self.env["PATH"]

    def test_real_clean_scan(self):
        self.assert_status(self.run_gate(), True)

    def test_real_finding_fails(self):
        (self.target / "finding.js").write_text("dangerous(1);\n", encoding="utf-8")
        result = self.run_gate()
        self.assert_status(result, False)
        self.assertIn("gate-test-rule", result.stdout)

    def test_real_invalid_rule_fails(self):
        self.rule.write_text(RULE.replace("severity: ERROR", "severity: INVALID"), encoding="utf-8")
        self.assert_status(self.run_gate(), False)

    def test_real_partial_parse_fails(self):
        (self.target / "broken.js").write_text("dangerous(\nconst = ;\n", encoding="utf-8")
        result = self.run_gate()
        self.assert_status(result, False)
        self.assertIn("PartialParsing", result.stdout)

    def test_real_semgrepignore_is_honored(self):
        (self.target / "ignored.js").write_text("dangerous(1);\n", encoding="utf-8")
        self.assert_status(self.run_gate(), False)
        (self.target / ".semgrepignore").write_text("ignored.js\n", encoding="utf-8")
        self.assert_status(self.run_gate(), True)

    def test_real_oversized_file_fails(self):
        (self.target / "large.js").write_text("//" + "x" * 1_000_001 + "\n", encoding="utf-8")
        result = self.run_gate()
        self.assert_status(result, False)
        self.assertIn("exceeded_size_limit", result.stdout)

    def test_real_explicitly_ignored_oversized_file_passes(self):
        (self.target / "large.js").write_text("//" + "x" * 1_000_001 + "\n", encoding="utf-8")
        (self.target / ".semgrepignore").write_text("large.js\n", encoding="utf-8")
        self.assert_status(self.run_gate(), True)

    def test_real_empty_rules_fail(self):
        self.rule.write_text("rules: []\n", encoding="utf-8")
        self.assert_status(self.run_gate(), False)

    def test_other_target_is_rejected(self):
        result = subprocess.run(
            [sys.executable, str(GATE), "--config", str(self.rule), str(self.target)],
            cwd=self.target, env=self.env, stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT, text=True, timeout=120,
        )
        self.assert_status(result, False)
        self.assertIn("Usage:", result.stdout)

    def test_subdirectory_target_is_rejected(self):
        subdirectory = self.target / "subdirectory"
        subdirectory.mkdir()
        result = subprocess.run(
            [sys.executable, str(GATE), "--config", str(self.rule), "."],
            cwd=subdirectory, env=self.env, stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT, text=True, timeout=120,
        )
        self.assert_status(result, False)
        self.assertIn("run from the Git repository root", result.stdout)

    def test_multiple_configs_cannot_hide_an_empty_ruleset(self):
        empty_rule = self.root / "empty.yml"
        empty_rule.write_text("rules: []\n", encoding="utf-8")
        result = subprocess.run(
            [sys.executable, str(GATE), "--config", str(self.rule), "--config", str(empty_rule), str(self.target)],
            env=self.env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            timeout=120,
        )
        self.assert_status(result, False)
        self.assertIn("Usage:", result.stdout)

    def test_invalid_json_fails(self):
        self.use_shim("not json", 0)
        self.assert_status(self.run_gate(), False)

    def test_scanner_failure_with_clean_json_fails(self):
        self.use_shim(json.dumps(clean_report()), 2)
        self.assert_status(self.run_gate(), False)

    def test_scanner_error_in_json_fails_even_with_zero_exit(self):
        report = clean_report()
        report["errors"] = [{"level": "warn", "type": "PartialParsing", "message": "partial parse"}]
        self.use_shim(json.dumps(report), 0)
        self.assert_status(self.run_gate(), False)

    def test_finding_in_json_fails_even_with_zero_exit(self):
        report = clean_report()
        report["results"] = [{"check_id": "gate-test-rule"}]
        self.use_shim(json.dumps(report), 0)
        self.assert_status(self.run_gate(), False)

    def test_missing_report_fields_fail(self):
        self.use_shim("{}", 0)
        self.assert_status(self.run_gate(), False)

    def test_empty_scan_fails(self):
        report = clean_report()
        report["paths"]["scanned"] = []
        self.use_shim(json.dumps(report), 0)
        self.assert_status(self.run_gate(), False)

    def test_missing_or_malformed_skipped_paths_fail(self):
        for skipped in (None, "not a list", ["not an object"], [{}], [{"path": "x", "reason": 7}]):
            with self.subTest(skipped=skipped):
                report = clean_report()
                report["paths"]["skipped"] = skipped
                self.use_shim(json.dumps(report), 0)
                self.assert_status(self.run_gate(), False)
        report = clean_report()
        del report["paths"]["skipped"]
        self.use_shim(json.dumps(report), 0)
        self.assert_status(self.run_gate(), False)

    def test_unexpected_skip_reason_fails(self):
        report = clean_report()
        report["paths"]["skipped"] = [{"path": "large.js", "reason": "exceeded_size_limit"}]
        self.use_shim(json.dumps(report), 0)
        result = self.run_gate()
        self.assert_status(result, False)
        self.assertIn("exceeded_size_limit", result.stdout)

    def test_explicit_ignore_reasons_are_allowed(self):
        for reason in ("semgrepignore_patterns_match", "Gitignore_patterns_match"):
            with self.subTest(reason=reason):
                report = clean_report()
                report["paths"]["skipped"] = [{"path": "ignored.js", "reason": reason}]
                self.use_shim(json.dumps(report), 0)
                self.assert_status(self.run_gate(), True)

    def test_missing_empty_or_malformed_rule_statistics_fail(self):
        for rules in (None, [], "not a list", [None], [""], [7]):
            with self.subTest(rules=rules):
                report = clean_report()
                report["time"]["rules"] = rules
                self.use_shim(json.dumps(report), 0)
                self.assert_status(self.run_gate(), False)
        for missing in ("time", "rules"):
            report = clean_report()
            if missing == "time":
                del report["time"]
            else:
                del report["time"]["rules"]
            self.use_shim(json.dumps(report), 0)
            self.assert_status(self.run_gate(), False)

    def test_scanner_does_not_receive_ci_credentials(self):
        names = (
            "SEMGREP_APP_TOKEN",
            "SONAR_TOKEN",
            "GH_TOKEN",
            "GITHUB_TOKEN",
            "ACTIONS_RUNTIME_TOKEN",
        )
        for name in names:
            self.env[name] = "test-placeholder"
        ambient_settings = self.root / "existing-settings.yml"
        ambient_settings.write_text("existing-settings\n", encoding="utf-8")
        self.env["SEMGREP_SETTINGS_FILE"] = str(ambient_settings)
        shim_dir = self.root / "bin"
        shim_dir.mkdir()
        shim = shim_dir / "semgrep"
        checks = " || ".join('[ "${' + name + '+x}" = x ]' for name in names)
        report = json.dumps(clean_report())
        shim.write_text(
            "#!/bin/sh\nif " + checks + "; then exit 19; fi\n"
            + '[ -n "${SEMGREP_SETTINGS_FILE-}" ] || exit 20\n'
            + '[ "$SEMGREP_SETTINGS_FILE" != ' + shlex.quote(str(ambient_settings)) + ' ] || exit 21\n'
            + '[ ! -s "$SEMGREP_SETTINGS_FILE" ] || exit 22\n'
            + "printf '%s\\n' "
            + shlex.quote(report) + "\n",
            encoding="utf-8",
        )
        shim.chmod(0o755)
        self.env["PATH"] = str(shim_dir) + os.pathsep + self.env["PATH"]
        self.assert_status(self.run_gate(), True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
