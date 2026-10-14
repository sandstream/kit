---
name: monkey-test
description: "Run the monkey test release gate for web and desktop (Tauri, Electron) apps, with role and money-flow checks when the app has them, including the trigger phrase \"run monkey-test\"."
allowed-tools: Bash, Read, Edit, MultiEdit, Write
---

# Monkey Test

Use when the user asks to run the monkey test, says "run monkey-test", or asks for a
release gate on a web or desktop app.

## Workflow

1. Run `kit monkey-test plan --json` from the target repo and read the stack,
   runner, env, seed, harness, `requirements`, `desktop`, role matrix, and
   security findings.
2. If the harness is missing or stale, run `kit monkey-test init`, review the
   generated files, and adapt selectors/routes/auth-state paths to the app.
3. Make prerequisites real before the gate: Playwright installed after triage,
   idempotent seed, temporary env from a provider CLI or vault command, and
   sandbox/test credentials only. Never write secrets to `.env`.
4. Run `kit monkey-test run` with the needed flags:
   `--env-command`, `--seed-command`, `--start-command` or `--base-url`, and
   `--link-depth`. For a Tauri or Electron app, also run
   `kit monkey-test desktop` (see Desktop Interruptions below).
5. Treat every finding as release-blocking unless it is listed in
   `MONKEY_EXPECTED_FINDINGS` or skipped with an explicit reason. Do not silence
   tests by deleting assertions, broadening ignores, or adding reasonless skips.
6. Fix real issues in the app, then re-run until the gate is green. Report
   remaining findings with severity, role, route, repro, and file.

## Release Gate

Roles and the money flow apply only when `plan` says so. `requirements.roles`
is required when the app has an auth dependency, a role or auth check in
runtime source, a role matrix with more than the public role, or a payment
provider. `requirements.money` is required when a payment provider is detected.
An app without roles, such as a single-user desktop app, is crawled as the
public visitor only and must not fail for missing roles. Do not delete auth or
payment code, or edit the matrix, to make a requirement go away.

For a desktop app (`plan.desktop` is set), the browser crawl covers the web UI
only. Drive the real app with a driver from `desktop.drivers`, run it on a
temporary data folder, and confirm that every folder in
`desktop.realDataDirs` is unchanged after the run.

When roles are required, the roles are:

- `public`: public visitor.
- `customer`: customer/buyer.
- `staff`: kiosk staff. This is its own role, not a kiosk device bucket.
- `owner`: owner/admin.
- `superadmin`: superadmin/support.

The gate must cover:

- Route crawl per required role on desktop and mobile viewports: 4xx/5xx, page
  errors, console errors, hydration/runtime errors, missing translations, fatal
  placeholder copy, loading/empty/error states, unlabeled controls, offscreen
  focusables, and control bloat.
- When money is required, at least one real sandbox/test money flow: add item,
  open payment shell, then cancel or confirm in test mode without live payment
  rails.
- Security pack: RLS/RPC authorization, cross-org isolation, webhook signature
  verification and idempotency, private-by-default buckets, no leaked secrets,
  CSP/security headers, sandbox-only Stripe/Connect or equivalent provider use,
  and immutable refunds/receipts/journal records. Checks that depend on
  payments or Supabase run only when those are present.

## Desktop Interruptions

A desktop user closes the window, quits, or loses the process while the app
works. `kit monkey-test desktop` drives the real debug build through its eval
hook on a temporary data folder, clicks at random, and interrupts each long
operation (save, export, upload, AI call, recording) with close-window, quit,
kill, reload, or restart. After each restart it checks that every data file
parses, no record is missing, the app starts without errors, and the operation
finished or the UI says it was interrupted. Silent loss is a finding.

1. Write `.kit/monkey-test/desktop.json` as `docs/MONKEY_TEST.md` describes. List
   every long operation the user can start, with an `outcome` script that reads
   what the user sees.
2. If the debug build has no data-folder override or eval hook, add both behind
   debug-only code before the run. Never point the run at real user data.
3. Run `kit monkey-test desktop`. Reproduce a finding with the `--seed` and
   `--actions` from its repro, fix the app, and re-run until it is green.

## Completion

Done means `kit monkey-test run` passes or the only remaining items are
explicitly expected with owner-approved reasons. Include the command output
summary in the final answer and name anything still unverified.
