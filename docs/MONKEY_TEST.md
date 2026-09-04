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

`run` executes the static security pack and, when Playwright prerequisites are
present, starts the app on a kit-chosen free port and runs the browser gate.
It deletes stale Playwright JSON output before the run and accepts browser
success only when the new report contains the current run ID, both configured
projects, every role crawl, and the money-flow case. A custom `--test-command`
must therefore run the generated monkey config and preserve its JSON reporter.

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
generated placeholders. Expected 401, 403,
404, access-denied redirects, and denial pages satisfy `denyRoutes`; allowed
routes must render successfully. Discovered same-origin links still receive UX,
runtime, and isolation checks.

## Runner Inputs

The runner uses a free local port unless `--base-url` points at an existing test
server. It passes `PORT`, `KIT_MONKEY_PORT`, and `MONKEY_BASE_URL` to the dev
server. Env values come from the current process plus optional `--env-command`,
whose stdout may be JSON or dotenv-style `KEY=VALUE` lines; kit never writes
those values to `.env`. A failed env command or any detected live payment
configuration stops the run before seed, dev server, or browser side effects.

Useful flags:

- `--start-command <cmd>`
- `--seed-command <cmd>`
- `--test-command <cmd>`
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
keywords, and browser back navigation are not payment evidence.

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

Static security detection ignores source comments and requires control-shaped
schema, query, or API operations. Checklist words alone do not satisfy RLS,
tenant isolation, webhook verification/idempotency, refund/receipt paths, or an
immutable journal.
