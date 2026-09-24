# kit data flow

> **Companion to** `THREAT_MODEL.md`. Diagrams of the principal data flows;
> configured providers, plugins, and delegated tools add destinations.

## Top-level flow

```
                    ┌──────────────────────────────────────┐
                    │      developer's machine             │
                    │                                      │
                    │   ┌──────────────┐                   │
                    │   │ .kit.toml │                   │
                    │   └──────┬───────┘                   │
                    │          │ refs                      │
                    │          ▼                           │
   ┌────────────┐   │   ┌──────────────┐                   │
   │ vault      │◀──┼───│ kit CLI   │                   │
   │ (1P /      │   │   │              │                   │
   │  Infisical │──▶│   │  read-only  │                   │
   │  /SM /KV)  │   │   │  default?    │                   │
   └────────────┘   │   └──┬───────┬───┘                   │
                    │      │       │                       │
                    │      │       └──▶ .kit-audit.jsonl│
                    │      │           (local, opt-in remote)
                    │      │                               │
                    │      │  HTTPS + token                │
                    └──────┼───────────────────────────────┘
                           ▼
                    ┌──────────────┐
                    │ vendor API   │
                    │ (Stripe,     │
                    │  Supabase,   │
                    │  Vercel, …)  │
                    └──────────────┘
```

The diagram shows the main paths. The network section below distinguishes kit's
own requests from plugin calls and commands delegated to other tools.

## Per-operation flows

### `kit check`

```
.kit.toml ──▶ kit ──▶ shell out to mise/op/etc (READ ONLY)
                  │
                  └──▶ stdout summary
                  └──▶ .kit-audit.jsonl (operation: "check")
```

The check itself reads project state, but its scanners and delegated tools may
contact registries or vendor endpoints. Interactive CLI invocations can also
check for kit and bumblebee updates; see the network table below.

### `kit secrets migrate` (plaintext → vault)

```
.env.production ──▶ planMigration() ──▶ writeSecretToBackend()
.env.staging         (scan + extract)    │
                                         ├──▶ 1P / Infisical / Vault CLI
                                         │    (token from operator's vault)
                                         │
                                         └──▶ .kit-audit.jsonl
                                              + cleanup .env (KEY=<blank>)
```

Read-only mode refuses at `writeSecretToBackend()` (`src/secrets-migrate.ts:137`).

### `kit secrets rotate --mode jwt-secret-roll` (Supabase)

```
.kit.toml ──▶ requireElevation()      [TTY prompt + TOTP]
                       │
                       ▼ ok
                consumeElevation()       [atomic read-then-delete marker]
                       │
                       ▼
              sandstream-kit-plugin-supabase
                       │
                       │ HTTPS PATCH /v1/projects/{ref}/api-keys/legacy/rotate
                       ▼
                  Supabase Mgmt API
                       │
                       ▼
              .kit-audit.jsonl  +  caller updates .env.local with new JWT
```

### `kit secrets vault-migrate --from 1password --to infisical`

```
.kit.toml [secrets.keys]                       (planMigration)
       │
       ▼
For each key:
       │
       ├──▶ readSecretFromBackend("1password")    HTTPS → 1P API
       │                  │
       │                  ▼ value (in-memory only)
       │
       ├──▶ writeSecretToBackend("infisical")     HTTPS → Infisical API
       │
       ├──▶ rewriteConfigRef(.kit.toml)        local file edit
       │
       └──▶ appendAuditEventDirect()              .kit-audit.jsonl
```

Failures at any step leave the previous step intact (no half-migration).
Source value is never logged; only the operation name + key.

### `kit auth elevate`

```
.kit.toml ──▶ TTY prompt (yes-prompt or TOTP)
                       │
                       ▼ verified
                grantElevation()
                       │
                       ▼
              .kit/elevation.json   (TTL'd marker, local only)
              .kit-audit.jsonl       (operation: "elevation-check")
```

Read-only mode refuses at `grantElevation()` (`src/elevation.ts:166`).

### Plugin write surfaces (Vercel / Stripe / GitHub / Fly / Cloudflare)

```
cli.ts caller ──▶ makeClient({ token })       token resolved from vault
                       │
                       ▼
              assertNotReadOnly()              process.env.KIT_READ_ONLY
                       │
                       ▼ ok
              fetch(vendor_url, ...)           HTTPS + AbortSignal.timeout
                       │
                       ▼
              vendor API response              parsed, stripped of headers
                       │                       in safeText() on error
                       ▼
              return structured result         no value-echoes in error msg
```

### Audit-log writer

```
appendAuditEventDirect({event}) ──▶ appendFile(.kit-audit.jsonl)
                                    │
                                    └──▶ if [governance.audit].remote == true
                                         AND company_id is configured
                                         ──▶ HTTPS POST to KIT_REMOTE_URL
                                             with exponential backoff
                                             ──▶ failed events → .kit-audit.pending
```

**Default:** local append only. Remote-push gate: explicit
`[governance.audit].remote = true` plus an explicit
`[governance.audit].company_id` in `.kit.toml` (one-time opt-in surfaces a loud
stderr notice on first send; a missing company id surfaces a configuration warning).

## Network destinations

These are built-in defaults, not a complete host allow-list. A configured API base
URL, self-hosted provider, git remote, plugin, adapter, or delegated CLI can add
destinations. Inspect the selected command and its configuration before applying
an egress policy. Some calls need no token; authentication on others is
API-specific. In particular, the Google Custom Search probe sends its API key in
a query parameter, so do not log full request URLs.

| Kit operation                   | Default destination                                                                          | Purpose                                                                            |
| ------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Interactive CLI version notices | `registry.npmjs.org`, `api.github.com/repos/perplexityai/bumblebee/releases`                 | Check for newer kit and pinned bumblebee versions; cached for 24 hours             |
| Bumblebee provisioning          | `github.com/perplexityai/bumblebee/releases/download`                                        | Download a checksum-pinned scanner when absent                                     |
| Package triage                  | `registry.npmjs.org`, `pypi.org`                                                             | Read package metadata                                                              |
| Web-search check                | `api.search.brave.com`, `www.googleapis.com`                                                 | Probe the configured Brave or Google search API                                    |
| Identity and service checks     | `app.infisical.com`, `api.github.com`, `graph.microsoft.com`, `cloudidentity.googleapis.com` | Verify configured credentials or memberships                                       |
| Optional provisioning adapters  | `api.neon.tech`, `api.planetscale.com`, `api.upstash.com`, `api.cloudflare.com`              | Create or inspect selected infrastructure                                          |
| Opt-in remote audit             | `${KIT_REMOTE_URL}`                                                                          | POST audit events when `[governance.audit].remote` and `company_id` are configured |

| First-party plugin | Default API destination                                           |
| ------------------ | ----------------------------------------------------------------- |
| Supabase           | `api.supabase.com`                                                |
| Vercel             | `api.vercel.com`                                                  |
| GitHub             | `api.github.com`                                                  |
| Stripe             | `api.stripe.com`                                                  |
| Fly                | `api.fly.io`, `api.machines.dev`                                  |
| Cloudflare         | `api.cloudflare.com`                                              |
| Sentry             | `sentry.io` (regional or self-hosted base URL configurable)       |
| Snyk               | `api.snyk.io` (regional base URL configurable)                    |
| Wiz                | `auth.app.wiz.io` plus the required tenant-specific `WIZ_API_URL` |

`KIT_NO_UPDATE_CHECK=1`, CI, and configured air-gap posture suppress the two
version notices. `KIT_BUMBLEBEE=0` disables the scanner download/scan but does
not suppress the version notice; use `KIT_NO_UPDATE_CHECK=1` as well if neither
request is wanted. `KIT_NO_DOWNLOAD=1` or a vetted `KIT_BUMBLEBEE_BIN` avoids
scanner provisioning. See [`AIR_GAP.md`](./AIR_GAP.md) for offline scanner setup.

Kit does not send default analytics or call an LLM provider. The optional audit
push goes only to the configured URL; adapters can provision analytics services
for the user's application.

## File-system writes

Examples of paths kit can write:

| Path                           | When                                               | Read-only refuses?                   |
| ------------------------------ | -------------------------------------------------- | ------------------------------------ |
| `.kit-audit.jsonl`             | every sensitive op                                 | no (audit IS the read-only-mode log) |
| `.kit-audit.pending`           | remote audit failed, queued                        | no                                   |
| `.kit-skipped-commits.jsonl`   | post-commit detector fires                         | no                                   |
| `.kit.toml`                    | `init`, `analyze --write`, `secrets vault-migrate` | yes                                  |
| `.kit/elevation.json`          | `auth elevate`                                     | yes                                  |
| `.kit-triage.jsonl`            | successful `kit triage`                            | no                                   |
| `.env*`                        | `secrets migrate` cleanup                          | yes                                  |
| `.env.template`                | `init` / regen                                     | yes                                  |
| `.git/hooks/{pre,post}-commit` | `hooks install`                                    | yes                                  |
| `~/.kit/totp-secret`           | `auth setup-totp`                                  | yes                                  |

Plus the standard `node_modules/`, `dist/`, etc. during build — but those are
not kit-specific.

## Dependency surface: 94 installed, 9 loaded

A reader auditing what kit can reach should know the gap between what `npm install`
puts on disk and what the process ever executes. Both numbers are measured, not
estimated; the second is a guard (`src/mcp-dependency-surface.test.ts`).

kit has **four** direct production dependencies:

| Dependency                  | Transitive closure                                          |
| --------------------------- | ----------------------------------------------------------- |
| `@modelcontextprotocol/sdk` | **91 packages** (90 of them reachable through nothing else) |
| `@upstash/redis`            | 2                                                           |
| `smol-toml`                 | 1                                                           |
| `zod`                       | 1                                                           |

Counts re-measured at SDK 1.30.0. They read 120/91 for the 1.29 tree; the install side moved with
the `@hono/node-server` 1.x → 2.x bump and the loaded side did not. The loaded number is gated
against `ROADMAP.md` by the guard test, since a count that lives only in prose drifts.

The SDK declares 17 **hard** dependencies (`optionalDependencies: {}`), among them a
complete HTTP server and OAuth stack — express 5, express-rate-limit, cors, hono,
`@hono/node-server`, raw-body, content-type, eventsource, jose, pkce-challenge — for
the Streamable-HTTP and SSE transports. kit imports exactly `server/mcp.js` and
`server/stdio.js`: it speaks **stdio**, over a pipe, and never starts a listener.

Traced while booting the server, listing tools and calling two of them, the packages
actually loaded are **9 of the 94**:

```
@modelcontextprotocol/sdk   zod   zod-to-json-schema   smol-toml
ajv   ajv-formats   fast-deep-equal   fast-uri   json-schema-traverse
```

None of the twelve HTTP/OAuth packages load, at startup or during a tool call. That
is inherited surface rather than executed code — which is exactly the distinction
that decides how to read a CVE in it. Two of the four advisories cleared on this
branch (`hono`, `ip-address`) sit in never-loaded code; `fast-uri` does **not** — ajv
reaches it when compiling the tool schemas.

> The trace needs BOTH an ESM `resolve` hook and a `Module._load` patch. `ajv` is
> CommonJS, so an ESM-only tracer reports 6 packages, silently omits `fast-uri`, and
> yields a rigorous-looking wrong answer. The test's sanity gate therefore asserts a
> CJS-only package is visible _before_ it is allowed to assert anything is absent.

## What's intentionally NOT shown here

- Build-time writes (`dist/`, `*.d.ts`) — not part of operational data flow.
- Test-fixture writes (under `tmpdir()`) — sandbox-scoped, deleted on test
  teardown.
- Stdout/stderr — visible by definition; not a data sink.
