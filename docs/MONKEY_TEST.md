# Monkey Test

`kit monkey-test` is a portable release gate for web and desktop applications.
It combines deterministic repo inspection, a Playwright harness, route crawling,
a security checklist, and, when the app has them, role separation and a sandbox
money-flow check.

## Commands

```sh
kit monkey-test plan --json
kit monkey-test init
kit monkey-test init --install
kit monkey-test run \
  --env-command 'provider-or-vault-cli export --format=dotenv' \
  --seed-command 'npm run seed:test'
```

`plan` detects the stack, package manager, Playwright state, dev server, local
env source, seed command, money provider markers, a Tauri or Electron desktop
shell, harness files, and static security findings. It also decides which
requirements apply (see [Requirements](#requirements)).

## Requirements

The role crawl and the money flow apply only when the app has roles or handles
money. `plan --json` reports the decision and the reason in `requirements`:

- `money.required` is true when a payment provider is detected (dependency or
  runtime source marker). The money flow then runs.
- `roles.required` is true when any of these is true: the money flow is
  required (it runs as a signed-in customer), an auth dependency is present
  (for example `next-auth`, `@clerk/*`, `@supabase/supabase-js`, `firebase`,
  `lucia`, `passport`), runtime source checks a role or a signed-in user
  (`create policy`, `hasRole(`, `user.role === "admin"`, `auth.uid()`), or the
  role matrix declares more than the public role or cannot be read.

The decision is fail-closed. A false positive restores the full five-role gate.
An app without roles is crawled as the public visitor only: `init` writes a
public-only role matrix, and `denyRoutes` and `forbiddenText` may be empty
because there is no other user to deny or leak to. `allowRoutes` and a seeded
`requiredText` marker stay mandatory. The runner passes the decision to the
generated spec as `MONKEY_ROLES_REQUIRED` and `MONKEY_MONEY_REQUIRED`, ignores
those names from `--env-command`, and validates the browser evidence against
the same plan. When the variables are missing or not `0`, the spec keeps the
full gate.

## Desktop apps

`plan` detects a Tauri app from `src-tauri/tauri.conf.json`,
`tauri.conf.json5`, `Tauri.toml`, or a `@tauri-apps/*` dependency, and an
Electron app from an `electron` dependency. `plan --json` reports `desktop`
with the identifier, product name, dev URL, the folders where this platform
keeps the app's real data, and the drivers that can control the real app:

- `eval-hook`: a debug-only hook in the app that runs JavaScript in the main
  window and writes the result to a file. It works on every platform and keeps
  working when the screen is locked, because each step is one evaluation.
- `tauri-driver`: WebDriver for Tauri on Linux and Windows. macOS has no
  WKWebView driver, so `plan` does not offer it there.
- `playwright-electron`: Playwright's Electron support.

The browser crawl reaches the web UI through the dev URL, but it cannot close,
quit, or restart the app. Before a desktop run, make debug builds read a
temporary data folder from an environment variable, so that the test never
touches real user data, and confirm afterwards that every folder in
`desktop.realDataDirs` is unchanged.

`init` creates or updates a managed harness:

- `playwright.monkey.config.ts`
- `tests/monkey/monkey.spec.ts`
- `tests/monkey/README.md`
- `tests/monkey/security-checklist.md`
- `.kit/monkey-test/role-matrix.json`
- `.kit/monkey-test/expected-findings.example.json`

`init --install` also sets up the browser runner. It runs `kit triage npm` on
`@playwright/test` at the exact version kit pins (1.55.0), and only if triage passes it
installs that version as an exact devDependency with the project's package manager and
`--ignore-scripts`. It then runs `playwright install chromium`, the one step that
downloads a browser. A project that already declares `@playwright/test` keeps its version:
only the Chromium download runs. On Windows kit prints the commands instead of running
them, because `.cmd` shims need a shell.

Kit triages whatever `@playwright/test` version will run: the pin for a fresh install, or the
installed version for a project that declares its own. Before it runs the installed cli, kit
downloads the tarball for that version from the public npm registry (in a scratch directory,
with an empty npm config, so no repo setting redirects it) and compares every file with the
installed package. A modified, missing or extra file stops the Chromium download. This covers
every package manager and the declared-version case.

Kit refuses to install when the repo could run its own code during install: `.pnpmfile.cjs`, a
`pnpmfile` or `global-pnpmfile` setting in `.npmrc` or `pnpm-workspace.yaml`, a yarn
`yarnPath`, `yarn-path` or `plugins` entry, or a `packageManager` value that is not a plain
`name@version` (corepack can fetch a package manager from a URL). A project registry
override cannot change what runs, because the files are checked against the public tarball.

Run `init --install` in a project you trust anyway. The guard is a tripwire, not a sandbox: a
package manager setting that kit does not know about can still run code during the install.

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
projects, every required role crawl, and the money-flow case when money is
required. The release gate invokes the
generated monkey config directly instead of trusting a repo test script. A custom
`--test-command` may run diagnostics, but cannot attest browser execution or make
the release gate green merely by writing a matching JSON report.

For browser runs, a missing Playwright dependency or incomplete harness stops
before the environment command, seed, server, or test command. Role validation
uses the temporary environment, then blocks seed/server/test on failure. A
failed or missing seed also blocks server/test. Explicit browser skips retain
their documented validation and seed behavior; skipping is not browser evidence.

`SKIP_SEED=1` in the environment behaves like `--skip-seed`: the seed step is
skipped, and the run still needs `--expected <reason>` or it is refused
(fail-closed). Prefer the flag; the variable exists for CI wrappers that cannot
edit the command line.

## Roles

When roles are required, the role matrix is fixed by the gate and can be mapped
to each app's auth fixtures:

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

This is browser evidence about the application's configured UI selectors. A
passing money-flow case does not prove that the app called a real Stripe, PayPal,
Braintree, Adyen, or Square sandbox endpoint, crossed a provider SDK boundary,
created a provider-side payment object, or received a verified webhook. The app
can render the expected final state without doing any of those things. For a
release that depends on provider settlement or webhooks, verify the provider
sandbox transaction and webhook path separately and retain its receipt.

## Findings

Output is a prioritized list with severity, area, role, route, repro, file when
known, and fix guidance. The command's gate stays red for every unresolved
finding, including low and medium findings.

Do not silence the gate by deleting assertions or broadening ignores. Expected
findings require `MONKEY_EXPECTED_FINDINGS` entries with exact `title`, `role`,
and `route`, plus a specific `reason`; optional fields narrow matching further.
This allowlist applies to generated browser findings, not static or runner
findings. Critical authorization findings cannot be waived. Reason-only entries
are rejected. Skips require `--expected <reason>` or
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

Known limitation: control-shaped is a lexical test, so a stub or a dead string
literal that has the shape of a control (an empty `verifyWebhookSignature`
function, a policy statement inside an unused string) can still satisfy a
static check. The static pass narrows what a reviewer must read; it is not proof
that a control runs. Review the browser run and retain a separate provider-side
sandbox transaction and webhook receipt when the release depends on them.

## Desktop run: clicks and interruptions

The browser crawl only clicks inside a page. A desktop user also closes the
window, quits, or loses the process while the app is working. `kit monkey-test
desktop` drives the real debug build of a Tauri or Electron app and does both:

```sh
kit monkey-test desktop --steps 200 --interruptions 5
kit monkey-test desktop --seed 4711 --actions kill   # repeat one finding
```

One seed chooses every random click and every interruption. Each finding's
repro contains the seed and the flags, so the same command against the same UI
repeats the run.

### What a run does

1. Fingerprints every folder in `realDataDirs`.
2. Creates a temporary data folder and a temporary hook folder.
3. Runs `seedCommand`, if set, with the data env variable pointing at the
   temporary folder.
4. Starts the app with `startCommand`, waits for `ready`, and installs an error
   monitor in the page. A canary error proves that the monitor works.
5. Clicks, types, and selects at random for `--steps` steps. Text inputs get
   hostile values, including an XSS payload. After each step it checks for page
   errors, unhandled rejections, console errors, native alerts, a blank window,
   runtime placeholders (`undefined`, `NaN`, `[object Object]`), technical error
   text in alerts (serde, Rust panics, `os error`), unlabeled controls, and a
   payload that ran as script.
6. At `--interruptions` seeded steps it starts one of the configured long
   operations, waits a seeded time, and performs a lifecycle action:

   | Action         | What it does                                                   |
   | -------------- | -------------------------------------------------------------- |
   | `close-window` | Runs `closeWindow` in the page, the user's close button.       |
   | `quit`         | SIGTERM to the app's process group, a pause, then a new start. |
   | `kill`         | SIGKILL, as a crash or a forced quit does. No cleanup runs.    |
   | `reload`       | Reloads the page. The process keeps running.                   |
   | `restart`      | SIGTERM and a new start at once.                               |

   The first five interruptions use each action once, in seeded order.

7. After each interruption it brings the app back and checks:
   - The app starts, its ready check answers, and the app log has no crash
     (Rust panic, `fatal runtime error`, segmentation fault, or a configured
     pattern).
   - Every file that matches `dataFiles` parses: JSON, JSON Lines, or TOML. A
     torn or empty file is a critical finding.
   - No data file disappeared, and the UI still shows every record that
     `records` returned before the interruption.
   - The operation's `outcome` script returns `done` or `interrupted`. It may
     return `running`, and the driver then waits up to `operationTimeoutMs`.
     Anything else means the work disappeared without a message. That is a
     finding, because the user cannot tell that something was lost.
8. At the end it stops the app, checks the data files again, and compares the
   real data folders with the first fingerprint. Any change is a critical
   finding.

The temporary folder is deleted after a clean run and kept after a run with
findings. It holds the data, the hook files, and `app.log`.

### Configuration

`.kit/monkey-test/desktop.json` (or `--config <path>`):

```json
{
  "startCommand": "bun run tauri dev",
  "seedCommand": "bun scripts/seed-test-data.ts",
  "dataDirEnv": "APP_DATA_DIR",
  "hookDirEnv": "APP_DEBUG_DIR",
  "realDataDirs": ["~/Library/Application Support/App"],
  "realDataIgnore": ["models"],
  "dataFiles": ["meetings/*.json", "settings.json"],
  "records": "return [...document.querySelectorAll('nav li .title')].map((el) => el.textContent.trim());",
  "operations": [
    {
      "name": "AI summary",
      "start": "document.querySelector('[data-action=summarize]').click(); return 'ok';",
      "outcome": "const s = document.querySelector('[data-summary-state]'); return s ? s.dataset.summaryState : 'lost';"
    }
  ],
  "closeWindow": "await window.__TAURI_INTERNALS__.invoke('plugin:window|close', { label: 'main' }); return 'ok';"
}
```

Optional fields: `ready` (default: the body has text), `logCrashPatterns`,
`startTimeoutMs` (300000), `stepTimeoutMs` (60000), and `operationTimeoutMs`
(120000). Scripts are function bodies. They may use `await` and must `return`.

List every long operation the user can start: save, export, upload, AI calls,
and recording. The `outcome` script is where the app says what happened to the
work, so write it against what the user sees, not against internal state.

### The app side: data folder and eval hook

The debug build must read two env variables. Release builds must ignore both.

- The data env variable (`dataDirEnv`) replaces the real data folder, so the
  test never reads or writes real user data.
- The hook env variable (`hookDirEnv`) names a folder. The app polls
  `<folder>/cmd.js`, deletes it, runs its content as the body of an async
  function in the main window, and writes the result to `<folder>/out.txt`. A
  string result is written as is; anything else as JSON.

The driver renames a complete file into `cmd.js` and wraps every body with a
nonce, so a late answer to an earlier command is never read as the current one.
Each command is one short evaluation, so the run keeps working when the screen
locks and the webview pauses its timers.

A Tauri 2 hook in `src-tauri/src/lib.rs`:

```rust
#[cfg(debug_assertions)]
fn debug_hook(app: tauri::AppHandle) {
    use tauri::Manager;
    let Some(dir) = std::env::var_os("APP_DEBUG_DIR").map(std::path::PathBuf::from) else { return };
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(100));
        let cmd = dir.join("cmd.js");
        let Ok(js) = std::fs::read_to_string(&cmd) else { continue };
        let _ = std::fs::remove_file(&cmd);
        if let Some(window) = app.get_webview_window("main") {
            let wrapped = format!(
                "(async()=>{{const inv=window.__TAURI_INTERNALS__.invoke;try{{const r=await (async()=>{{{js}\n}})();await inv('debug_report',{{text:typeof r==='string'?r:JSON.stringify(r)}})}}catch(e){{await inv('debug_report',{{text:'ERR '+e}})}}}})()"
            );
            let _ = window.eval(&wrapped);
        }
    });
}

#[cfg(debug_assertions)]
#[tauri::command]
fn debug_report(text: String) {
    if let Some(dir) = std::env::var_os("APP_DEBUG_DIR") {
        let _ = std::fs::write(std::path::PathBuf::from(dir).join("out.txt"), text);
    }
}
```

Register `debug_report` in the invoke handler and call `debug_hook` from
`setup`. In an Electron main process, poll the same file and run the body with
`webContents.executeJavaScript`.

### Limits

- The driver uses the eval hook. It does not use `tauri-driver` or Playwright's
  Electron support yet.
- The process-group stop is verified on macOS and Linux. Windows process trees
  are not verified.
- The web Playwright harness does not run interruptions. Reload and tab close
  during a long operation in a web app are not covered yet.
- The checks see what the app writes and shows. They cannot prove that an
  operation that reports `done` produced a correct result.
