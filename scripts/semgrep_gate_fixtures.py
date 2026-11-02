"""Shared fixtures for the Semgrep gate tests."""

from pathlib import Path

GATE = Path(__file__).resolve().with_name("run-semgrep.py")
RULE = """\
rules:
  - id: gate-test-rule
    languages: [javascript]
    message: gate test finding
    severity: ERROR
    pattern: dangerous(...)
"""


def clean_report():
    return {
        "results": [],
        "errors": [],
        "paths": {"scanned": ["clean.js"], "skipped": []},
        "time": {"rules": ["test-rule"]},
    }
