# Host-ops Capture

Any machine that runs unattended — a VPS, a bot host, a build box, a self-hosted
service — accumulates operational state that lives only on disk and in one
person's head. When that box dies, gets reimaged, or the person leaves, the config
is gone. The fix is simple and non-negotiable: **the server's governance lives in
the repo, not on the server.** If you can't rebuild the box from version control,
you don't control it.

This pairs with kit's secret handling: capture the *config* in the repo, keep the
*values* in a vault. Names and structure are committed; secrets are referenced.

## The rule

Whenever you stand up or change an always-on host, commit the artifacts below to a
tracked `ops/<host>/` (or `infra/<host>/`) directory, and keep them in sync when
they change on the box. Secrets are referenced, never committed.

## Capture checklist

- [ ] **systemd units** (or equivalent supervisor config) — every `*.service`,
      `*.timer`, and any drop-in overrides for daemons the box runs. Copy them from
      `/etc/systemd/system/` (and `--user` units) into the repo verbatim.
- [ ] **Reverse-proxy / web-server config** — the nginx / Caddy / Traefik server
      blocks, TLS settings, and upstream routing. Note where certs come from
      (e.g. ACME issuer) — the renewal mechanism, not the private key.
- [ ] **Cron jobs / scheduled tasks** — crontab entries and any systemd timers,
      with what they run and on what cadence. A scheduled job nobody remembers is a
      future outage.
- [ ] **Backup scripts + schedule** — the backup command/script, what it backs up,
      where it writes, retention, and how the schedule is wired (cron/timer).
- [ ] **Firewall / network rules** — open ports, allow-lists, and any VPN/overlay
      network membership, enough to reproduce the network posture.
- [ ] **Env / config inventory** — the *names* and purpose of required env vars and
      config files (e.g. an `.env.example`), and where each secret is sourced from
      (which vault/secret store). Never the secret values.
- [ ] **Service inventory** — a short list of every long-running process on the box
      and its purpose, so an outsider knows what is supposed to be running.

## Restore runbook (the other half — write it)

Committing config files is not enough; an operator under pressure needs the
*sequence*. Write `ops/<host>/RESTORE.md` covering, in order:

1. **Provision** — OS/image, sizing, and where to get it (provider, region).
2. **Bootstrap** — install the runtimes/packages the services need.
3. **Place config** — copy the committed units/proxy/cron into their system paths,
   reload the supervisor (`systemctl daemon-reload`, enable + start units).
4. **Inject secrets** — where each secret comes from and how it lands on the box
   (secret manager/vault, manual placement) — referencing the env inventory above.
5. **Restore data** — how to recover from the latest backup, and how to verify it.
6. **Verify** — concrete checks that prove the box is healthy: services active,
   proxy answering, a smoke request succeeding, backups running again.

Keep it executable in spirit: each step should be a command or a precise pointer,
not a vague gesture. Prefer scripts the runbook invokes over prose the operator
must translate.

## Sync discipline

Drift kills this practice. When you change a unit, proxy block, cron entry, or
backup script *on the box*, mirror the change into the repo in the same work — the
committed copy is the source of truth, the box is a deployment of it. A periodic
diff between the live config and the committed copy catches silent drift before an
outage does.
