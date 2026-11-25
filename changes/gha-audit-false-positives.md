### Fixed

- **`kit gha-audit` no longer reports `uses:` text inside a `run:` script as an unpinned action.**
  The action scan ran over the whole file, so an `echo "  - uses: owner/action@main"` usage hint
  in a shell step was reported as a step. It now skips `|`/`>` block-scalar bodies and matches only
  a `uses:` key (at a line start, after a list dash, or in a flow mapping). Found on a published
  action's usage message by kit-research.
- **The pwn-request rule accepts a `workflow_run` job guarded to push-triggered runs.** A job whose
  `if:` requires `github.event.workflow_run.event == 'push'` (alone, and-ed with other conditions,
  or or-ed only with another event such as `github.event_name == 'workflow_dispatch'`) never runs
  for a pull request's run, so its checkout of `workflow_run.head_sha` is no longer reported as
  bringing in pull-request code. Unguarded jobs, or-ed and negated guards are still reported.
- **The skippable-gate rule counts an aggregator that passes `toJSON(needs)` to a script.** An
  `if: always()` job that needs the gated job and hands the whole `needs` context to a check
  script was not recognised, because only a literal `.result` counted.
- **The unused `id-token: write` finding names the third-party actions kit did not read.** When a
  job calls a third-party action (for example an Azure Key Vault signing setup), the message now
  says no step kit can read uses an OIDC token and names the unread action(s), instead of saying
  no step uses it.
