### Added

- **`kit review gate --pr <n> [--repo owner/name] [--json]` gives any maintainer the review gate
  kit's own reviewer App applies.** It is read-only and deterministic, and it never posts. It
  reads the pull request, its files, its head's check runs (paged explicitly), the default
  branch's CI and `.github/kit-protected-paths.json` on the default branch. It then prints one
  verdict with its reasons and the exact head SHA it judged: `approve` (exit 0), `owner` (3:
  protected path, a module with 20+ importers, or more than 1500 changed lines), `hold` (4: failed
  checks or a red main), `pending` (5) or `incomplete` (6: something could not be read; a read
  error never approves). A repo without the rule file gets kit's built-in protected paths, and
  the output says so. Each run appends one `review.gate` row to kit's audit log (repo, PR, head,
  verdict, reasons, time), so the log records who decided what on which head. Before, the gate
  lived only in kit's repo (`scripts/agent-review-gate.mjs`, run by a GitHub App), and 10 of the
  last 200 kit merges were neither approved on head nor routed to the owner, with no record of
  who decided (kit-research `ai-pr-flood-maintainers-vs-kit`). The command reads GitHub, not the
  agent, so it covers Claude, Codex and any other harness alike. The decision logic lives in
  `src/review-gate.ts`. `src/review-gate-parity.test.ts` runs 216 fixtures through it and through
  the App's script, and fails on any difference in verdict or reason.
