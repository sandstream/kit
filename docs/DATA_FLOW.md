# kit data flow

> **Companion to** `THREAT_MODEL.md`. ASCII diagrams of every place kit
> reads, writes, or sends data.

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

**Promise:** every arrow is intentional and visible. No undocumented network
calls, no hidden file writes.

## Per-operation flows

### `kit check`

```
.kit.toml ──▶ kit ──▶ shell out to mise/op/etc (READ ONLY)
                  │
                  └──▶ stdout summary
                  └──▶ .kit-audit.jsonl (operation: "check")
```

Pure read. No network calls except the tools kit shells out to (which
themselves may hit vendor endpoints).

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
                                    └──▶ if companyId AND
                                         [audit].remote == true
                                         ──▶ HTTPS POST to KIT_REMOTE_URL
                                             with exponential backoff
                                             ──▶ failed events → .kit-audit.pending
```

**Default:** local append only. Remote-push gate: explicit
`[audit].remote = true` in `.kit.toml` (one-time opt-in surfaces a loud
stderr notice on first send).

## Network hosts contacted

The exhaustive list of network destinations kit can reach. Every call
includes the operator-supplied token in `Authorization:` headers — never
in URL paths or query strings.

| Plugin | Destination | Method |
|---|---|---|
| supabase | `https://api.supabase.com/v1/...` | GET/POST/PATCH/DELETE |
| vercel | `https://api.vercel.com/v9..v13/...` | GET/POST/PATCH/DELETE |
| github | `https://api.github.com/repos/{owner}/{repo}/actions/...` | GET/PUT/DELETE |
| stripe | `https://api.stripe.com/v1/webhook_endpoints` | GET/POST/DELETE |
| fly | `https://api.fly.io/graphql`, `https://api.machines.dev/v1/...` | POST/GET |
| cloudflare | `https://api.cloudflare.com/client/v4/...` | GET/PUT/DELETE |
| (opt-in) audit | `${KIT_REMOTE_URL}/api/companies/{id}/audit-logs` | POST |

No analytics, no telemetry, no LLM provider, no third-party logging service — those
remain true.

> **This table is PLUGIN egress, not everything kit can reach.** It said "the exhaustive
> list" and "the entire egress list", and it is not: kit's own scanner provisioning
> fetches `https://api.github.com/repos/perplexityai/bumblebee/releases`
> (`bumblebee-update.ts:51`) and downloads from
> `https://github.com/perplexityai/bumblebee/releases/download` (`bumblebee.ts:57`) —
> neither is in the table, and the release-download host is not the `api.github.com`
> path the github plugin row describes. A reviewer who used this table as an allow-list
> for an egress-filtered or air-gapped deployment would find `kit check --category
> security` attempting an undocumented download. Set `KIT_NO_DOWNLOAD` (or supply
> `KIT_BUMBLEBEE_BIN`) to keep provisioning offline. Treat the table as complete for
> plugin traffic and incomplete for kit's own toolchain until each provisioning path is
> enumerated here.

## File-system writes

Exhaustive list of paths kit can write:

| Path | When | Read-only refuses? |
|---|---|---|
| `.kit-audit.jsonl` | every sensitive op | no (audit IS the read-only-mode log) |
| `.kit-audit.pending` | remote audit failed, queued | no |
| `.kit-skipped-commits.jsonl` | post-commit detector fires | no |
| `.kit.toml` | `init`, `analyze --write`, `secrets vault-migrate` | yes |
| `.kit/elevation.json` | `auth elevate` | yes |
| `.kit-triage.jsonl` | successful `kit triage` | no |
| `.env*` | `secrets migrate` cleanup | yes |
| `.env.template` | `init` / regen | yes |
| `.git/hooks/{pre,post}-commit` | `hooks install` | yes |
| `~/.kit/totp-secret` | `auth setup-totp` | yes |

Plus the standard `node_modules/`, `dist/`, etc. during build — but those are
not kit-specific.

## Dependency surface: 120 installed, 9 loaded

A reader auditing what kit can reach should know the gap between what `npm install`
puts on disk and what the process ever executes. Both numbers are measured, not
estimated; the second is a guard (`src/mcp-dependency-surface.test.ts`).

kit has **four** direct production dependencies:

| Dependency | Transitive closure |
|---|---|
| `@modelcontextprotocol/sdk` | **91 packages** |
| `@upstash/redis` | 2 |
| `smol-toml` | 1 |
| `zod` | 1 |

The SDK declares 17 **hard** dependencies (`optionalDependencies: {}`), among them a
complete HTTP server and OAuth stack — express 5, express-rate-limit, cors, hono,
`@hono/node-server`, raw-body, content-type, eventsource, jose, pkce-challenge — for
the Streamable-HTTP and SSE transports. kit imports exactly `server/mcp.js` and
`server/stdio.js`: it speaks **stdio**, over a pipe, and never starts a listener.

Traced while booting the server, listing tools and calling two of them, the packages
actually loaded are **9 of the 120**:

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
> CJS-only package is visible *before* it is allowed to assert anything is absent.

## What's intentionally NOT shown here

- Build-time writes (`dist/`, `*.d.ts`) — not part of operational data flow.
- Test-fixture writes (under `tmpdir()`) — sandbox-scoped, deleted on test
  teardown.
- Stdout/stderr — visible by definition; not a data sink.
