# Skills architecture

> Status: **spec / design**. No code committed against this yet. This is the
> target architecture for how kit manages agent skills across a fragmented
> ecosystem of registries and runtimes.

## Thesis

The skills ecosystem has many distribution points (Claude plugins, agentskills.io,
skills.sh, openclaw/clawhub, plain GitHub repos) but they converge on **one runtime
artifact**: a `SKILL.md` (plus optional scripts) placed in a directory that an agent
runtime loads. The format is converging; distribution and consumption are fragmented.

kit's job is NOT to become another marketplace. Hosting or curating skills would
explode the trust surface and contradict kit's zero-LLM, local-first posture (see
`THREAT_MODEL.md`, "Plugin marketplace storage" is explicitly out of scope). kit is
the layer **above** the marketplaces and **below** the runtimes: a deterministic
build-and-governance pipeline that takes a skill from any source, governs it
(triage, pin, lock, verify), and places it for any target runtime.

In one line: **kit is a source-agnostic, target-agnostic skill build and governance
layer. Marketplaces and runtimes are just endpoints.**

## Layers (and the two meanings of "plugin")

Three layers, top is closest to the running agent:

```
A. RUNTIME (runs the agent, LOADS capabilities)
   Claude Code / Claude Cowork / Codex / Cursor
B. CAPABILITIES (what the runtime loads)
   skills (SKILL.md) / Claude plugins (bundles) / MCP servers
   distributed by: claude.com/plugins / agentskills.io / skills.sh / clawhub / GitHub
C. kit (PREPARES B for A — governance/build layer)
   declare(.kit.toml) -> resolve -> triage -> lock -> place -> verify
   federates over the marketplaces in B
   - SkillSource adapters    (resolve skills per source)
   - kit-plugins = packages/kit-plugin-*  (ServiceAdapters: railway/supabase/...) — extend KIT itself
```

The word "plugin" means two different things on opposite sides of kit, and they must
never be conflated:

| | **kit-plugin** (`packages/kit-plugin-*`) | **Claude plugin** (claude.com/plugins) |
| --- | --- | --- |
| Layer | C (inside kit) | B (a capability) |
| Extends | kit (the CLI) | the runtime (Claude Code/Cowork) |
| Does | ServiceAdapters: provision/login/secrets for services | bundles skills + commands + agents + hooks + MCP |
| Loaded by | kit | Claude |
| Format | `packages/adapter-sdk` | Anthropic's plugin spec |

A kit-plugin is part of the engine that PREPARES the environment. A Claude plugin is
part of the environment that GETS prepared. In this architecture a Claude plugin is
just one SOURCE on the source axis (`plugin:marketplace/name`, a bundle source); a
kit-plugin is kit's own extension mechanism. kit is never itself something a runtime
loads.

## Building your own (when no one has built it)

kit is designed to fill gaps, not wait for a marketplace. There are three levels of
"build your own", each governed identically (triage, pin, lock, verify):

| Level | When | How |
| --- | --- | --- |
| Author a skill | no skill exists for a capability | write your own `SKILL.md` -> `local` source (the authoring loop) |
| SkillSource adapter | a registry has no kit integration | implement `resolve`/`fetch`/`triageTarget` for it |
| kit-plugin (ServiceAdapter) | a service has no kit integration | build against `packages/adapter-sdk` (like railway/supabase) |

`steipete/agent-scripts` is the real-world proof of the first level: a personal repo of
`skills/<name>/SKILL.md` with a `validate-skills` hook, published to skills.sh via a
manifest. Nobody built it for him; he built it and federates it out. kit governs exactly
that pattern.

## Two axes

Skills move along two independent axes. kit spans both.

### Source axis (where a skill comes from)

The source is selected by the version string in `.kit.toml [skills]`. `src/lock.ts`
(`parseSkillVersion`) already resolves three of these; the rest are new adapters.

| Spec in `.kit.toml`                     | Source            | Status      |
| --------------------------------------- | ----------------- | ----------- |
| `"./skills/my-skill"`                   | authored-local    | exists      |
| `"owner/repo"` / `"github:owner/repo@tag"` | GitHub         | exists      |
| `"^2.0"` / `"1.2.3"` (semver)           | clawhub (openclaw)| exists      |
| `"agentskills:slug"`                    | agentskills.io    | new adapter |
| `"skillsh:slug"`                        | skills.sh (Vercel)| new adapter |
| `"plugin:marketplace/name"`             | Claude plugin     | new adapter |

`github-private` is also a known `sourceType` (auth via the github service).

### Target axis (where a skill runs)

One canonical skill is placed into each target runtime's convention. This is the
same cross-harness muscle kit already uses for memory files (it merges `CLAUDE.md`,
cursor rules, codex, gemini, cline, continue, amazonq). Targets are declared in
config, for example `[skills] targets = ["claude-code", "cowork"]`.

| Target          | Placement convention                    | Status        |
| --------------- | --------------------------------------- | ------------- |
| Claude Code     | `.claude/skills/<name>/SKILL.md`        | known         |
| Claude Cowork   | (verify exact location before building) | needs-confirm |
| Codex / Cursor  | each runtime's skill/rules convention   | later         |

> Open item: confirm Claude Cowork's skill location and whether it differs from
> Claude Code's `.claude/skills/`. Do not place into Cowork until verified.

## Data flow

```
                 SOURCE                         GOVERNANCE (kit)                 TARGET
 authored-local ─┐                        ┌─ triage gate (PASS only) ─┐     ┌─ claude-code
 github ─────────┤  resolve(spec)         │  pin + lock (hash)        │     ├─ cowork
 clawhub ────────┼─►  SkillSource ──────► │  validate (SKILL.md)      ├───► ├─ codex
 agentskills ────┤    adapter             │  verify in kit check      │     └─ cursor
 skills.sh ──────┤                        └───────────────────────────┘
 plugin ─────────┘
```

kit never authors content and never hosts a registry. It resolves, governs, and
places. The creative authoring is done by Claude (Code or Cowork); the fetching is
delegated to each source's own tooling.

## The `SkillSource` adapter interface

Mirrors the existing `ServiceAdapter` pattern in `src/adapters/`. One adapter per
source, registered in an index, selected by the parsed spec.

```ts
export interface SkillSource {
  /** Source key, e.g. "github", "clawhub", "agentskills". */
  readonly kind: string;

  /** True if this adapter handles the given parsed spec. */
  matches(spec: ParsedSkillSpec): boolean;

  /**
   * The triage target for this skill, for the watertight gate. A skill backed by
   * a repo returns { type: "repo", target: "https://github.com/owner/repo" }; a
   * registry skill maps to the registry's underlying repo or a "skill" triage.
   * Returns null only for authored-local (triaged by content scan, not upstream).
   */
  triageTarget(spec: ParsedSkillSpec): TriageTarget | null;

  /** Resolve the concrete version + a content identity (commit/tag/digest). */
  resolve(spec: ParsedSkillSpec): Promise<ResolvedSkill>;

  /**
   * Fetch + materialize the skill into a staging dir. Delegates to the source's
   * own installer where one exists (openclaw for clawhub, git for github, the
   * Claude plugin system for plugin:). Never trusts bytes it did not verify.
   */
  fetch(resolved: ResolvedSkill, stageDir: string): Promise<FetchedSkill>;
}
```

`resolve`/`fetch`/`triageTarget` are the only verbs an adapter must implement.
Placement, locking, and verification are shared kit machinery, not per-adapter.

## Governance (the invariants, uniform across both axes)

Every skill, whether authored locally or pulled from any registry, and regardless
of which runtime consumes it, passes the same gates:

1. **Triage.** Reuse the watertight gate (`src/triage-gate.ts`, `kit triage skill`).
   Only an explicit triage PASS lets an install proceed; WARN, FAIL, offline, and
   unmappable all block (fail-closed). Authored-local skills are scanned for
   secrets and frontmatter validity instead of an upstream reputation triage.
2. **Pin + lock.** `skills-lock.json` records `sourceType`, the resolved version,
   and a **content integrity hash** of the materialized SKILL.md tree (the same
   tamper-evidence idea bumblebee uses for binaries). Reproducible regardless of
   source.
3. **Validate.** Deterministic checks on the SKILL.md: frontmatter schema, a
   description-quality lint, no embedded secrets, no name collision with an
   installed skill.
4. **Place.** Write the canonical skill into each declared target's directory.
5. **Verify.** `kit check` (via `src/check-skills.ts`) confirms each required
   skill is present in each target and that the on-disk content still matches the
   locked hash.

No source, no registry, and no runtime is trusted by fiat.

## Authoring loop (create your own skills with Claude)

Clear division of labor: **Claude creates, kit governs.**

1. **Scaffold** (kit, deterministic, zero-LLM): `kit skills new <name>` writes a
   SKILL.md skeleton with valid frontmatter and the directory layout.
2. **Author** (Claude Code or Cowork): the actual content. This is the LLM step.
   kit does not generate prose.
3. **Validate** (kit, deterministic): frontmatter schema, description lint, secret
   scan, name-collision check.
4. **Lock + place** (kit): record as `local` sourceType with a content hash in
   `skills-lock.json`; place into each target runtime.
5. **Publish (optional)**: delegate to the chosen registry's CLI
   (`openclaw publish`, a GitHub push, etc.). kit does not host the result.

Authoring is therefore just another source (`local`), and publishing is just
delegation. The integrity hash means an authored skill is as tamper-evident as a
fetched one.

## `skills-lock.json` (target shape)

```jsonc
{
  "version": 1,
  "skills": {
    "coding-agent": {
      "sourceType": "clawhub",
      "source": "coding-agent@^2.0",
      "resolved": "2.3.1",
      "integrity": "sha256-…",        // hash of the materialized SKILL.md tree
      "targets": ["claude-code", "cowork"]
    },
    "my-skill": {
      "sourceType": "local",
      "source": "./skills/my-skill",
      "integrity": "sha256-…",
      "targets": ["claude-code"]
    }
  }
}
```

## Phasing

Build in order; each phase is independently useful.

1. **Bootstrap (unblock today).** Get the triage skill and `openclaw` installed so
   the existing clawhub path works again. The current `kit check` failures
   (`coding-agent`/`github`/`gh-issues` missing) are "declared but never
   installed", not an architecture gap.
2. **Formalize `SkillSource`.** Extract the interface from `parseSkillVersion` and
   ship the **GitHub adapter** first: it is the most universal, since nearly every
   marketplace skill is a git repo underneath, and it composes with the existing
   triage `repo` target.
3. **Per-registry adapters.** Add only the registries actually used
   (agentskills.io, skills.sh, plugin). Verify each registry's resolve/fetch
   contract before implementing.
4. **Integrity in the lock.** Add the content hash to `skills-lock.json` and the
   verify step, closing the tamper-evidence gap.
5. **Cross-target placement.** Generalize kit's cross-harness memory placement to
   skills, starting with Claude Code, then Cowork once its location is confirmed.

## Open decisions

- **Which 1 to 2 sources first?** Recommendation: GitHub adapter (universal) plus
  the existing clawhub path. Add agentskills.io / skills.sh / plugin only on demand.
- **Which targets first?** Recommendation: Claude Code now; Claude Cowork after its
  skill location is confirmed.
- **Skill-only or also Claude plugins (bundles)?** Recommendation: skill-only at the
  core. A plugin bundles skills, commands, agents, hooks, and MCP, which is a much
  larger surface; treat a plugin as a future bundle source that delegates to the
  Claude plugin installer, not as the core unit.

## Out of scope (and why)

- **Hosting or curating a registry.** kit federates over registries; it does not
  store skills or run a marketplace. This keeps the trust surface bounded.
- **Authoring content.** kit scaffolds and validates deterministically; Claude
  writes the content. kit stays zero-LLM.
- **Trusting any source by default.** Every source flows through the same triage,
  pin, lock, and verify path.

## Reference source

`steipete/agent-scripts` (https://github.com/steipete/agent-scripts) is the recommended
first test source for the GitHub adapter: a real repo of `skills/<name>/SKILL.md` (YAML
frontmatter: name, description), a `scripts/validate-skills` hook, and a `skills.sh.json`
manifest that publishes to skills.sh. The GitHub adapter consumes it directly; it also
reveals the skills.sh contract for free (see below).

## Verification gaps

Resolved by inspecting `steipete/agent-scripts`:

- **skills.sh contract (resolved):** skills.sh is a git repo plus a `skills.sh.json`
  manifest (`groupings[].skills[]` naming `skills/<name>/` dirs). The skills.sh adapter
  reads the manifest and pulls the named skill dirs from the repo. No bespoke API. In
  practice the GitHub adapter alone already covers such repos, so the skills.sh adapter
  is a thin layer on top.
- **SKILL.md layout (confirmed):** `skills/<name>/SKILL.md` with YAML frontmatter is the
  universal unit, identical to Claude Code's convention.

Still open:

- Confirm Claude Cowork's skill location and load convention.
- Confirm what agentskills.io exposes for programmatic resolve/fetch.
- Confirm `openclaw`'s install/publish contract and where clawhub is actually hosted
  (the registry name is referenced by kit; the hosting lives in openclaw, not in kit's
  source). This is also the current bootstrap blocker: the triage skill kit shells to
  (`~/.claude/skills/triage/scripts/triage.py`) is an external skill kit does not ship,
  so the gate cannot run until it is installed.
