# kit sentinel — design

Status: draft (design approved 2026-06-21, spec under review)

## One sentence

kit deterministically probes a project's *connected* external systems once a
day in a cloud routine; an agent triages any red findings and leaves the right
artifact (a fix PR, an issue, or a suppression PR) waiting for a human, while
the start of any session surfaces only the queue.

## Problem

Today external systems report problems *to a human who then has to start from
zero*. A scheduled health cron (an email-delivery canary, a domain-status
check) fires a `Sentry.captureMessage`, Sentry emails a person, and that
person has to open the dashboard, reconstruct context, find the cause, and
write the fix by hand.
The same is true for a failed Vercel prod deploy, a red GitHub Actions run, a
Supabase Security Advisor regression, or an expiring TLS cert. The detection
exists; the *investigation and the proposed fix* do not. The human is the
first responder for everything.

kit already has the spine for the other half of this: the PAL ledger
(detect -> remediate -> track -> remind -> auto-close) and the SessionStart
surface hook (`[PAL · N open]`). kit sentinel extends PAL's sensors from
*local* checks (`kit check`, secret scan, setup gaps) to *external runtime
systems*, and adds an agentic responder on top that does the investigation and
drafts the fix before the human ever looks.

## Goals

- A human starts their day to find problems already investigated and a
  reviewable fix (or a clear human-action checklist) waiting — not a raw alert.
- Detection stays deterministic, read-only, and account-verified inside kit
  (zero-LLM core preserved).
- Sensors are *derived from the project's connected services*, never a manual
  pick-list. Adding a sensor is a data row, like adding a service.
- No silent muting: even "this is benign noise" is a reviewable artifact.
- Cheap always-on: a normal session never makes a heavy network call.

## Non-goals (YAGNI / by design)

- kit does not embed or call an LLM. The agentic responder is the harness
  layer (a Claude Code / CCR routine), not kit core.
- The agent never auto-merges, never rotates a secret, never touches a prod
  DB, never force-pushes. Those classes become an *issue*, not a PR.
- Not a dashboard or a monitoring product. GitHub (PRs + issues) is the queue;
  kit owns detection and scaffolding only.
- No new always-running daemon. The heavy sweep is a scheduled routine; the
  local footprint is one throttled read at session start.

## Decisions (locked in brainstorm 2026-06-21)

1. **Architecture boundary — kit detects, agent fixes.** kit does the
   deterministic external probes and writes findings; a separate agent reads
   them, investigates, and produces artifacts. kit stays zero-LLM.
2. **Cadence — both, throttled.** SessionStart always surfaces the cached
   queue instantly (no network). The heavy sweep (probes + agent) runs at most
   once per day.
3. **Agent mechanism — remote daily routine.** A scheduled CCR routine (cloud,
   via the `/schedule` mechanism) runs the sweep and opens artifacts
   out-of-band, so it never consumes the user's local session or tokens.
   SessionStart only reads the result.
4. **Sensors — derived from connected services.** The sensor set is whatever
   the project is actually connected to (detected via the existing service
   registry + `[context]` block + `[secrets]` keys). Not selected by hand.
5. **Output — right artifact per finding class** (after triage):
   - code-fixable -> **draft PR** with the fix
   - human / customer / infra action -> **GitHub issue** + diagnosis + checklist
   - benign noise -> **draft PR** that adds the suppression (never a silent mute)

## Architecture

Three layers, with the LLM boundary between layer 1 and layer 2.

### Layer 1 — `kit health` (deterministic, in kit)

A new read-only command. Reads the service registry, the `[context]` block,
and `[secrets]` keys to learn which external systems the project is connected
to, probes each one for which a `healthProbe` is defined, and emits structured
findings.

- **Account-verified.** Each probe runs against the account/org/ref declared in
  `[context]` (the context-lock principle). It states which source it checked.
  This bakes in the "verify the source before concluding something is absent"
  rule — the probe can never silently hit the wrong Sentry org or Supabase ref
  and report "all clear."
- **Read-only.** Probes only read (`gh run list`, `vercel ls`, a Sentry issue
  search, `supabase ... advisors`, a Resend domains GET, an `openssl s_client`
  cert read). No mutation, ever.
- **Output:** `kit health --json` -> a list of findings:
  `{ sensor, source (org/ref/env checked), status: green|red|unknown,
     severity, title, evidence, firstSeen, suggestedClass }`.
  `unknown` (e.g. token missing in the cloud env, probe errored) is distinct
  from `green` — never collapse a skipped probe into "healthy".
- Red findings are mirrored into PAL (selective: red only, dedup by stable id),
  reusing the existing `kit memory pal` import + dedup.

### Layer 2 — the responder (agent, in the harness / cloud)

A scheduled CCR routine that kit scaffolds (see Layer 3). Once a day it:

1. Runs `kit health --json` in the cloud checkout.
2. For each red finding, **triages**: is this real, is it mine, which class is
   it? The triage prompt requires the agent to state which org/env/branch it
   verified before concluding anything (the misattribution guard, again).
3. Produces the artifact for the class:
   - **code-fixable** -> a draft PR with the fix, body states the verified
     source and the evidence, labeled `kit-sentinel`.
   - **human/customer/infra** -> a GitHub issue with the diagnosis and an
     action checklist (e.g. "customer domain X failed Resend verification:
     contact org, re-add DNS records A/B/C"), labeled `kit-sentinel`.
   - **benign noise** -> a draft PR that adds the suppression (e.g. a Sentry
     `ignoreErrors` entry for a known-benign cross-tab auth-lock error), so
     muting is a human-reviewed change, never silent.
4. Leaves everything as **draft** / open. Never merges, never closes.

kit's role here is only to *generate* this routine and its pinned prompt. The
LLM work is entirely in the harness.

### Layer 3 — `kit sentinel install` (scaffolder, in kit) + SessionStart surface

- **`kit sentinel install`** generates the CCR routine wired to the project's
  connected services, the pinned responder prompt, the required-token
  declaration, and the SessionStart surface hook. The user hand-authors
  nothing. Mirrors how the existing `/schedule` skill creates routines and how
  `kit agent-config` wires hooks/permissions.
- **Required tokens.** The cloud routine can only probe a system whose
  credentials are present in the cloud env. kit derives the required token per
  connected service from the registry, declares them, and **warns on any
  missing token** — that sensor is skipped and reported as `unknown`, never a
  silent gap.
- **SessionStart surface hook.** A cheap, throttled (cache <= 6h) read of
  `gh pr list --label kit-sentinel` + open `kit-sentinel` issues, rendered as
  `[sentinel · N waiting on you]`. No heavy network on a normal session. This
  extends the existing PAL surface hook rather than adding a new one.

## Sensor registry

Add an optional `healthProbe` field to the existing `ServiceDef` in
`src/service-registry.ts`, beside `login` / `check` / `secrets`:

```
healthProbe?: {
  cmd: string            // read-only probe, account-scoped via [context]
  parse: ...             // map output -> finding(s)
  requiresToken: string  // env/secret key needed in the cloud routine
  defaultClass: 'code' | 'human' | 'noise'  // triage hint, agent may override
}
```

A sensor is probed only when the project is connected to that service.
Adding a sensor = one data row. v1 rows cover a common web stack:

| Sensor | Probe (read-only) | Typical class |
|---|---|---|
| GitHub Actions | `gh run list` failing/red runs | code |
| Vercel deploys | `vercel ls` failed prod deploy | code |
| Sentry | new unresolved issues / error spike since last sweep | code or noise |
| Supabase | Security Advisor findings + migration drift | code or human |
| Resend | domain status + email canary terminal event | human |
| TLS cert | `openssl s_client` expiry window | human/infra |

## Data flow

```
[daily, cloud routine]
  kit health --json            (deterministic, account-verified, read-only)
    -> findings[]
  agent triages each red finding (states verified source)
    -> code      -> draft PR (fix)      label kit-sentinel
    -> human     -> issue (diagnosis)   label kit-sentinel
    -> noise     -> draft PR (suppress) label kit-sentinel

[any session, local]
  SessionStart hook: gh pr/issue list --label kit-sentinel (cached <=6h)
    -> "[sentinel · N waiting on you]"
```

GitHub is the cross-machine ledger (the routine runs in the cloud; the human
reads from any machine). Local PAL optionally mirrors the same red findings
for the local `kit check`/PAL view.

## Guardrails

- Draft PRs only; **never auto-merge**, never close. Everything labeled
  `kit-sentinel` for one-glance filtering and easy revert.
- **Verify-source-before-concluding** is mandatory in both layers: the probe
  records the org/ref/env it checked; the agent must restate it before acting.
- The agent edits repo code only. Prohibited classes (rotate a key, touch prod
  DB, force-push, change access control) are surfaced as an *issue*, never
  executed and never a code PR.
- Missing cloud token -> sensor skipped, reported `unknown`, surfaced. No
  silent coverage gaps.
- Suppression is always a reviewable draft PR. The agent never mutes an alert
  source on its own.

## Error handling

- Probe errors / offline / missing token -> finding `status: unknown` with the
  reason; never silently dropped, never miscounted as green.
- The routine is idempotent per finding: dedup by stable finding id so a
  re-run does not open duplicate PRs/issues (reuse PAL's dedup-by-id and a
  `kit-sentinel:<finding-id>` marker in the PR/issue body).
- If a finding's artifact already exists and is open, update it rather than
  reopen a new one.

## Testing

- **Layer 1 (`kit health`)** — unit-test each `healthProbe.parse` against
  captured fixture output (red, green, unknown). Test that an account mismatch
  vs `[context]` yields `unknown`+reason, not `green`. Test dedup-by-id and
  PAL mirroring. Test missing-token -> `unknown`.
- **Layer 3 (`kit sentinel install`)** — test the generated routine wires only
  connected services, declares the right tokens, warns on missing ones, and
  installs the surface hook without clobbering existing hooks (reuse the
  hooksPath-aware install path).
- **Layer 2 (responder)** — not kit-tested (it is harness/LLM); validate via a
  dry-run of the routine against a fixture repo and inspect the artifacts.

## Phasing

1. **v1a — `kit health` + registry `healthProbe`** for the common web-stack
   sensors (GitHub Actions, Vercel, Sentry, Supabase, Resend, cert), JSON out,
   PAL mirror. Pure detection; usable on its own (`kit health` in a terminal).
2. **v1b — SessionStart surface hook** reading `kit-sentinel` artifacts.
3. **v1c — `kit sentinel install`** scaffolder + the pinned responder prompt +
   token declaration.

Each phase is independently shippable; v1a delivers value alone.

## Open decisions

- Command name: `kit sentinel` vs `kit health` vs `kit watch`/`guard`/`standup`.
  Working assumption: `kit health` = the deterministic probe command;
  `kit sentinel install` = the scaffolder. Confirm naming before build.
- Whether local PAL mirroring of external findings is in v1a or deferred (the
  GitHub queue is the source of truth regardless).
- Sweep schedule default (e.g. 05:00 local) and per-project override.

## Reuses (do not reinvent)

service registry + `detectServices()`; `[context]` context-lock and
`kit context check`; PAL import + dedup-by-id + the SessionStart surface hook;
the `/schedule` CCR routine mechanism; `kit agent-config` hook/permission
wiring; hooksPath-aware hook install.

## Related

PAL roadmap (detect -> remediate -> track -> remind -> auto-close);
context-lock v2 (Supabase ref); cross-account context safety; the scheduled
health crons that motivated this (delivery canary, domain-status check).
