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

## Roles

The role matrix is fixed by the gate and can be mapped to each app's auth
fixtures:

- `public`: public visitor.
- `customer`: customer/buyer.
- `staff`: kiosk staff. This is a distinct role, not a kiosk device bucket.
- `owner`: owner/admin.
- `superadmin`: superadmin/support.

## Runner Inputs

The runner uses a free local port unless `--base-url` points at an existing test
server. It passes `PORT`, `KIT_MONKEY_PORT`, and `MONKEY_BASE_URL` to the dev
server. Env values come from the current process plus optional `--env-command`,
whose stdout may be JSON or dotenv-style `KEY=VALUE` lines; kit never writes
those values to `.env`.

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

- `MONKEY_ROUTES=/,/shop,/account`
- `MONKEY_LINK_DEPTH=2`
- `MONKEY_CUSTOMER_STATE=.auth/customer.json`
- `MONKEY_STAFF_STATE=.auth/staff.json`
- `MONKEY_OWNER_STATE=.auth/owner.json`
- `MONKEY_SUPERADMIN_STATE=.auth/superadmin.json`
- `MONKEY_MONEY_ROUTE=/shop`
- `MONKEY_ADD_TO_CART='button:has-text("Add")'`
- `MONKEY_CHECKOUT='button:has-text("Checkout")'`
- `MONKEY_CONFIRM_TEST_PAYMENT=1`
- `MONKEY_CONFIRM_PAYMENT='<selector>'`

## Findings

Output is a prioritized list with severity, area, role, route, repro, file when
known, and fix guidance. Critical and high findings should block release.

Do not silence the gate by deleting assertions or broadening ignores. Expected
findings require `MONKEY_EXPECTED_FINDINGS` entries with a specific `reason`.
Skips require `--expected <reason>` or `MONKEY_EXPECTED_REASON`.
