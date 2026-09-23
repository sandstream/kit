# Monkey Test

`kit monkey-test` is a portable release gate for applications that handle money.
It combines deterministic repo inspection, a Playwright harness, role-based route
crawling, a sandbox money-flow check, and a security checklist.

## Commands

```sh
kit monkey-test plan --json
kit monkey-test init
kit monkey-test run \
  --env-command 'provider-or-vault-cli export --format=dotenv' \
  --seed-command 'npm run seed:test'
```

`plan` detects the stack, package manager, Playwright state, dev server, local
env source, seed command, money provider markers, harness files, and static
security findings.

`init` creates or updates a managed harness:

- `playwright.monkey.config.ts`
- `tests/monkey/monkey.spec.ts`
- `tests/monkey/README.md`
- `tests/monkey/security-checklist.md`
- `.kit/monkey-test/role-matrix.json`
- `.kit/monkey-test/expected-findings.example.json`

Repeat init preserves existing Playwright configuration, role matrix, and expected
findings example byte-for-byte, including with `--force`. Other existing files are
refreshed only when they carry the Kit managed marker and `--force` is supplied;
unmarked files remain operator-owned. Symlinked parents and nonregular or multiply
linked destinations are skipped. Publication stages a complete file before replacing
the leaf entry, so refreshing a scaffold does not write through its linked target.
These pathname checks are not protection against hostile concurrent parent renames.

`run` executes the static security pack and, when Playwright prerequisites are
present, starts the app on a kit-chosen free port and runs the browser gate.
It deletes stale Playwright JSON output before the run and accepts browser
success only when the new report contains the current run ID, both configured
projects, every role crawl, and the money-flow case. The release gate invokes the
generated monkey config directly instead of trusting a repo test script. A custom
`--test-command` may run diagnostics, but cannot attest browser execution or make
the release gate green merely by writing a matching JSON report.

For browser runs, a missing Playwright dependency or incomplete harness stops
before the environment command, seed, server, or test command. Role validation
uses the temporary environment, then blocks seed/server/test on failure. A
failed or missing seed also blocks server/test. Explicit browser skips retain
their documented validation and seed behavior; skipping is not browser evidence.

## Roles

The role matrix is fixed by the gate and can be mapped to each app's auth
fixtures:

- `public`: public visitor.
- `customer`: customer/buyer.
- `staff`: kiosk staff. This is a distinct role, not a kiosk device bucket.
- `owner`: owner/admin.
- `superadmin`: superadmin/support.

After `init`, edit `.kit/monkey-test/role-matrix.json`. For every role, replace
the placeholders with:

- `allowRoutes`: routes this role must reach.
- `denyRoutes`: routes this role must receive an intentional denial for.
- `requiredText`: seeded positive-control markers that must appear for this role.
- `forbiddenText`: seeded cross-org markers that must never appear for this role.

Set `configured` to `true` only after every role has non-empty values. The
browser gate fails closed while the matrix is unconfigured or still contains
generated placeholders. A `denyRoutes` navigation must return HTTP 401, 403, or
404, or land on a different pathname that exactly matches one of these denial
routes: `/login`, `/sign-in`, `/unauthorized`, `/forbidden`, `/access-denied`.
Path matching is case-sensitive and does not accept trailing slashes, nested
paths, or longer names such as `/admin/login-audit` or
`/reports/forbidden-attempts`. Query strings and fragments are ignored; changing
only those does not count as a redirect. Other denial destinations must return
401, 403, or 404 to satisfy the gate. Denial wording in an HTTP 200 body is not
proof of denied access. Denial responses and redirects still receive cross-org
isolation checks.

Allowed routes must render successfully. Discovered same-origin links still
receive UX, runtime, and isolation checks.

## Runner Inputs

The runner uses a free local port unless `--base-url` points at an existing test
server. It passes `PORT`, `KIT_MONKEY_PORT`, and `MONKEY_BASE_URL` to the dev
server. Env values come from the current process plus optional `--env-command`,
whose stdout may be JSON or literal dotenv `KEY=VALUE` assignments, including
`export KEY=VALUE`; kit never writes those values to `.env`. A failed env command,
invalid output, or detected live payment configuration stops the run before
seed, dev server, or browser side effects. Stripe live prefixes are checked in
trimmed values regardless of the variable's name. Refusal reports omit values.

Planning and execution inspect root `.env`, `.env.local`, and their development,
test, production and valid `NODE_ENV` mode variants. Files must be readable regular
files of at most 512 KiB. The parser accepts a conservative literal subset and
refuses ambiguous loader syntax, colon assignments, unsupported escapes, NUL bytes,
and unresolved variable or command references. Effective process and provider
values must also be literal. Resolve references through the provider/vault before
running; do not write provider secrets into dotenv files to bypass a refusal.
The runner checks again after provider/seed/server stages before starting the next
stage. These checks do not sandbox application code, cover arbitrary custom env
loaders or nested workspaces, or prevent files from changing during a running child.

Streamed seed/test logs go to stderr with secret redaction, leaving JSON stdout
for the result. SIGINT/SIGTERM abort the run and clean up its tracked process
groups, including commands still starting. Completed groups are retired promptly,
and surviving descendants are cleaned before a command reports completion.
This uses POSIX process-group probes, not kernel-level identity handles; Windows
descendant cleanup is not equivalent and has not been verified.

Useful flags:

- `--start-command <cmd>`
- `--seed-command <cmd>`
- `--test-command <cmd>` (diagnostic only; cannot attest the browser gate)
- `--env-command <cmd>`
- `--base-url <url>`
- `--link-depth <n>`
- `--skip-seed --expected <reason>`
- `--skip-browser --expected <reason>`
- `--skip-security --expected <reason>`

Useful Playwright env:

- `MONKEY_ROLE_MATRIX=.kit/monkey-test/role-matrix.json`
- `MONKEY_LINK_DEPTH=2`
- `MONKEY_CUSTOMER_STATE=.auth/customer.json`
- `MONKEY_STAFF_STATE=.auth/staff.json`
- `MONKEY_OWNER_STATE=.auth/owner.json`
- `MONKEY_SUPERADMIN_STATE=.auth/superadmin.json`
- `MONKEY_MONEY_ROUTE=/shop`
- `MONKEY_ADD_TO_CART='button:has-text("Add")'`
- `MONKEY_CHECKOUT='button:has-text("Checkout")'`
- `MONKEY_PAYMENT_MODE=test` (also accepts `sandbox`; never `live`)
- `MONKEY_PAYMENT_SHELL='<selector>'`
- `MONKEY_SANDBOX_INDICATOR='[data-payment-mode="test"]'`
- `MONKEY_PAYMENT_ACTION=cancel` with `MONKEY_CANCEL_PAYMENT='<selector>'` and
  `MONKEY_CANCELLED_STATE='<selector>'`
- `MONKEY_PAYMENT_ACTION=confirm` with `MONKEY_CONFIRM_PAYMENT='<selector>'`
  and `MONKEY_CONFIRMED_STATE='<selector>'`

The money flow runs with customer storage state. It adds a product, opens the
configured payment shell, verifies visible sandbox evidence, performs the
chosen action, and asserts the configured post-action state. Page text, URL
keywords, and browser back navigation are not payment evidence. Payment shell,
sandbox indicator, action control, and final state must use distinct, specific
selectors. Document-wide selectors such as `body`, `html`, `:root`, and `*` are
refused. Runtime and dotenv inspection also rejects live/production mode signals
for Stripe, PayPal/Braintree, Adyen, and Square before seed or browser side effects.

## Findings

Output is a prioritized list with severity, area, role, route, repro, file when
known, and fix guidance. Critical and high findings should block release.

Do not silence the gate by deleting assertions or broadening ignores. Expected
findings require `MONKEY_EXPECTED_FINDINGS` entries with exact `title`, `role`,
and `route`, plus a specific `reason`; optional fields narrow matching further.
Reason-only entries are rejected. Skips require `--expected <reason>` or
`MONKEY_EXPECTED_REASON`, and skip only the named pack: prerequisite, harness,
temporary-env, and seed validation still run.
Skipping browser execution or its money-flow case always leaves the release gate
red even when the exception has a reason; a money-app release requires fresh
desktop/mobile browser evidence and at least one completed sandbox money flow.

Static detection filters comments per source language, including JavaScript
template expressions and HTML comments; executable decrement expressions and
string URLs remain visible. This is lexical evidence, not a full language parser
or proof that payment code runs. Payment dependencies remain independent signals.
Static security detection requires control-shaped
schema, query, or API operations. Checklist words alone do not satisfy RLS,
tenant isolation, webhook verification/idempotency, refund/receipt paths, or an
immutable journal.
