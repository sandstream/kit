# Sentinel Layer 2 — the responder (agent-agnostic) — design

**Issue:** #52. **Builds on:** `docs/specs/2026-06-21-kit-sentinel-design.md` (layer 1 = `kit health`/`kit check` → PAL red findings, shipped).

## The hard constraint (CEO, 2026-06-23)

The responder must be **agent-agnostic**: it works with **any** coding agent — Claude
Code, Codex, Cursor, Gemini, … — and must not bind to one runtime. kit also stays
**zero-LLM** (its invariant). Those two together force the architecture below.

## The contract: kit proposes, any agent disposes, any scheduler triggers

kit does NOT call an LLM, does NOT open PRs/issues, and does NOT embed an agent.
Layer 2 is a **pure, deterministic translation**: red findings → a stable, typed
**remediation-proposal** document. Three independent roles, decoupled by that contract:

```
 [scheduler]            [kit — zero-LLM]                 [any agent]
 cron / GH Action  ──►  kit sentinel run --json   ──►   reads proposals,
 launchd / CI          (PAL red findings →               opens the artifacts
 (BYO, agnostic)        typed proposals + dedup)          with ITS creds (BYO, agnostic)
```

- **kit** is the deterministic engine: classify each red finding, emit the exact
  artifact it should become (title, body, branch, labels, suggested commands).
- **the agent** (whichever) consumes `--json` and executes — makes the code change,
  opens the draft PR / issue / suppression PR — using its own model + the user's creds.
- **the scheduler** (whichever) invokes `kit sentinel run` on a cadence. kit is
  stateless + idempotent, so the scheduler is interchangeable.

This is the same propose-pattern kit already uses (`kit memory suggest`, `kit heal
--agent`): kit emits structured work; the agent acts. Layer 2 generalizes it to the
finding→artifact arc and makes the JSON the **agnostic seam**.

## The proposal contract (the agnostic seam)

`kit sentinel run --json` →

```jsonc
{
  "generatedAtMarker": "<caller stamps time>",
  "proposals": [
    {
      "findingId": "health:vercel:prod-deploy-failed",   // stable; the dedup key
      "class": "code" | "human" | "noise",
      "artifact": "draft-pr" | "issue" | "suppression-pr",
      "title": "…",
      "body": "… includes the <!-- kit-sentinel:findingId --> marker …",
      "branch": "kit/sentinel/<findingId-slug>",          // draft-pr / suppression-pr only
      "labels": ["kit-sentinel", "…"],
      "suggestedCommands": ["…"],                          // deterministic hints, optional
      "alreadyOpen": false                                 // set by dedup (below)
    }
  ]
}
```

`kit sentinel run --agent <claude-code|codex|cursor|…>` emits the same proposals
formatted as that agent's idiom (a prompt block), mirroring `kit agent-config`'s
multi-target table — but the JSON is canonical; the `--agent` views are sugar.

## Triage → artifact (from the layer-1 design, unchanged)

| finding class | artifact | who acts |
|---|---|---|
| **code** (a fix in this repo) | **draft PR** — kit proposes branch + change description + commands; the agent makes the change & opens the draft | agent |
| **human / customer / infra** (DNS, billing, a vendor dashboard) | **issue + checklist** — kit proposes the body; the agent opens it | agent |
| **noise** (benign, to be filtered) | **suppression PR** — kit proposes the edit to `.kit/sentinel-suppress.toml`; agent opens a draft PR. **Never a silent mute.** | agent |

## Dedup / idempotency (kept in kit, deterministic)

Re-runs must not pile up duplicates. kit embeds a `<!-- kit-sentinel:<findingId> -->`
marker in every artifact body, and before emitting a proposal it **reads open
issues/PRs read-only** (via `gh`/`glab`/`bitbucket` — the host CLIs kit already shells)
and sets `alreadyOpen: true` when the marker exists. The agent skips `alreadyOpen`
proposals. kit doing the host *read* keeps dedup deterministic; the agent still owns
all *writes*. Host CLI absent → kit emits with `alreadyOpen: null` (agent dedups, fail-open).

## What kit must NOT do (the boundary)

- No LLM call anywhere in kit (invariant).
- No PR/issue creation by kit (that is the agent's write, with the agent's creds).
- No agent-specific assumption in the JSON contract (the agnostic seam).
- No silent suppression (noise → a reviewable PR, never an auto-mute).

## Open decisions for sign-off (before any build)

1. **Dedup reads:** OK for `kit sentinel run` to do read-only `gh/glab` calls to set
   `alreadyOpen`? (Alternative: leave all dedup to the agent — simpler kit, weaker guarantee.)
2. **Suppression store:** `.kit/sentinel-suppress.toml` (committed, by-findingId) — confirm path/shape.
3. **`--agent` sugar in v1**, or JSON-only first and add agent-idiom formatting later?

## Then layer 3 (#53)

`kit sentinel install` wires a chosen scheduler to `kit sentinel run` + adds the
SessionStart `[sentinel · N]` surface that reads the cached proposals. Out of scope here.
