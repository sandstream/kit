### Fixed

- **The `secrets scan` fallback without TruffleHog fails on provider-shaped keys.** An unquoted
  `OPENAI_API_KEY=sk-proj-…` in a committed `AGENTS.md`, and a Stripe key in a committed
  `dist/assets/*.js`, passed as "Git grep found no matches" while `kit security scan-staged`
  blocked the same files. The fallback now applies kit's shared secret patterns to tracked files
  and fails on a key that names a provider by its prefix. Generic and public-by-design shapes (a
  JWT, a Google `AIza` key, a Stripe `pk_` key) stay with the grep, and the row still says
  coverage is unverified. Found by measuring an AI-built app against kit (sandstream/kit-research#230).
- **`kit monkey-test plan` gives a secret finding a repro that reproduces it.** It named `kit
security scan-artifact`, which runs ClamAV and says nothing about secrets. The repro is now a
  ripgrep command with the shared pattern that matched.
- **`kit monkey-test plan` checks RLS per table.** One table with row level security and a policy
  satisfied the rule for every table, so a migration that created `invoices` without RLS was not
  flagged. Each table a SQL migration creates now needs RLS and a policy on it, and the finding
  names the tables and points at the migration that creates them, not at `.kit.toml`.
- **`built bundle secrets` scans browser build output when no framework is declared.** It
  skipped with "nothing builds for a browser" while `dist/assets/index-*.js` existed. A root
  build directory with an `index.html`, or JavaScript under `assets/` or `static/`, is now
  scanned. A build directory with JavaScript only at its top, such as a Node CLI's `dist/`, is
  named as found and not scanned.
