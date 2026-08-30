---
name: monkey-test
description: "Run the monkey test release gate for money-handling apps, including the trigger phrase \"kör apa-test\"."
allowed-tools: Bash, Read, Edit, MultiEdit, Write
---

# Monkey Test

Use when the user asks to run the monkey test, says "kör apa-test", or asks for a
role-based release gate on an app that handles money.

## Workflow

1. Run `kit monkey-test plan --json` from the target repo and read the stack,
   runner, env, seed, harness, role matrix, and security findings.
2. If the harness is missing or stale, run `kit monkey-test init`, review the
   generated files, and adapt selectors/routes/auth-state paths to the app.
3. Make prerequisites real before the gate: Playwright installed after triage,
   idempotent seed, temporary env from a provider CLI or vault command, and
   sandbox/test credentials only. Never write secrets to `.env`.
4. Run `kit monkey-test run` with the needed flags:
   `--env-command`, `--seed-command`, `--start-command` or `--base-url`, and
   `--link-depth`.
5. Treat every finding as release-blocking unless it is listed in
   `MONKEY_EXPECTED_FINDINGS` or skipped with an explicit reason. Do not silence
   tests by deleting assertions, broadening ignores, or adding reasonless skips.
6. Fix real issues in the app, then re-run until the gate is green. Report
   remaining findings with severity, role, route, repro, and file.

## Release Gate

The required roles are:

- `public`: public visitor.
- `customer`: customer/buyer.
- `staff`: kiosk staff. This is its own role, not a kiosk device bucket.
- `owner`: owner/admin.
- `superadmin`: superadmin/support.

The gate must cover:

- Route crawl per role on desktop and mobile: 4xx/5xx, page errors, console
  errors, hydration/runtime errors, missing translations, fatal placeholder copy,
  loading/empty/error states, unlabeled controls, offscreen focusables, and
  control bloat.
- At least one real sandbox/test money flow: add item, open payment shell, then
  cancel or confirm in test mode without live payment rails.
- Security pack: RLS/RPC authorization, cross-org isolation, webhook signature
  verification and idempotency, private-by-default buckets, no leaked secrets,
  CSP/security headers, sandbox-only Stripe/Connect or equivalent provider use,
  and immutable refunds/receipts/journal records.

## Completion

Done means `kit monkey-test run` passes or the only remaining items are
explicitly expected with owner-approved reasons. Include the command output
summary in the final answer and name anything still unverified.
