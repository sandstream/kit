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

That's the entire egress list. No analytics, no telemetry, no LLM provider,
no third-party logging service.

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

## What's intentionally NOT shown here

- Build-time writes (`dist/`, `*.d.ts`) — not part of operational data flow.
- Test-fixture writes (under `tmpdir()`) — sandbox-scoped, deleted on test
  teardown.
- Stdout/stderr — visible by definition; not a data sink.
