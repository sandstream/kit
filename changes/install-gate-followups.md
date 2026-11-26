### Security

- **A triage receipt whose timestamp does not parse no longer counts as fresh for a bare install.**
  `freshReceipts` compared `Date.parse(timestamp) < cutoff`; an unparseable timestamp is `NaN`,
  `NaN < cutoff` is false, so a garbage timestamp passed as a triage from the last 7 days
  (fail-open). It now rejects a non-finite timestamp, as `kit triage check-deps` already did.
- **The install gate now reads `pip-sync`, `python -m piptools sync` and `uv pip sync`.** They
  install a requirements file but matched no install rule, so they passed the gate silently. An
  untracked requirements file they name (or `requirements.txt` for a bare `pip-sync`) now needs a
  fresh `kit triage pip` receipt for every requirement, with the refusal `pip install -r` gives. An
  index option, `--find-links`, `--pip-args`, a config file, uv's `--directory` or stdin is refused.
