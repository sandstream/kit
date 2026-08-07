---
id: ADR-0005
title: Browser verification substrate is owned by kit
status: accepted
---

# ADR-0005: Browser verification substrate is owned by kit

## Decision

kit owns the deterministic browser-verification substrate. A repo declares only
its app-server contract in `.kit.toml`:

```toml
[browser]
app = "apps/frontend"
start = "npm --workspace apps/frontend run start"
build = "npm --workspace apps/frontend run build"
routes = "apps/frontend/e2e/static-routes.spec.ts"
port = 3107
```

`kit browser doctor`, `kit browser status`, `kit browser cdp-url`, and
`kit browser playwright-env` diagnose the local machine and emit either a
selected strategy or a concrete blocker. The experimental strategy order is:
project Playwright with installed browser, missing Playwright browser as an
explicit setup blocker, system Chrome/Chromium, configured or reachable CDP,
then blocker.

Agent workflow skills sit above this. A future `browser-verification` skill
should call `kit browser doctor` and read the diagnosis instead of guessing
whether the failure came from Playwright, Chrome, CDP, sandboxing, or the app.

## Rationale

Browser verification fails differently per host: package manager state,
Playwright cache location, Chrome availability, CDP profiles, sandbox support,
and remote-debugging ports. Those facts are deterministic and local. Re-solving
them in every repo or skill creates divergent scripts and vague handoffs.

Keeping this in kit gives every agent the same zero-LLM preflight and leaves
skills free to encode workflow discipline: when to verify, how to interpret app
failures, and how to save evidence.

## Consequences

- `[browser].port` is the app-server port. It is required once `[browser]` is
  declared.
- `kit browser doctor` does not start the app, build the app, run Playwright
  specs, or write receipts yet.
- CDP discovery honors `KIT_BROWSER_CDP_URL`, then `[browser].cdp_url`, then a
  localhost `9222` probe.
- `kit browser playwright-env` prints shell exports for callers that need to
  run Playwright with the selected environment.
- The command remains experimental until `kit browser test` can run declared
  routes in a real repo and persist verification evidence.
