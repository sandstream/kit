# kit Roadmap

State on **2026-06-02** — what's shipped, what's coming. Public-flip happens with
everything in **Shipped**; items in **Planned** land as incremental releases.

Contributions on any planned item are welcome — open an issue first to coordinate.

---

## Shipped (v1.1.x)

### Core
- `kit init / check / fix / install / login / secrets / setup / audit / doctor / env`
- `.kit.toml` config + Zod schema, `cli-lock.json`, `skills-lock.json`
- Mise integration for tool versions
- Git hooks management
- Skills system (`.claude/skills`)
- Plugin system + adapter SDK (`packages/adapter-sdk`, `packages/sandstream-kit-plugin-railway` reference)
- MCP server (`kit mcp`)
- Team / RBAC (`kit team`)

### Security
- `npm audit`, `semgrep`, `trivy`, `license-checker` (with `npx` fallback), `bumblebee`
  supply-chain scan, `secrets scan`, `.env` gitignore check
- Triage: `kit triage npm/pip/docker/repo/skill --sandbox`
- Test-coverage enforcement with universal baseline

### Secret backends
- `env` — `process.env`
- `1password` — `op read <ref>`
- `config` — literal value in `.kit.toml`
- `infisical` — bulk export via `infisical export --format=json`
- `bitwarden` — `bw get <field>`
- `doppler` — `doppler secrets get <name> --plain`
- `eas` — Expo Application Services secrets *(candidate for plugin extraction; see Planned)*
- `vault` — HashiCorp Vault KV v2
- `aws-sm` — AWS Secrets Manager
- `gcp-sm` — GCP Secret Manager
- `azure-kv` — Azure Key Vault
- `dotenvx` — encrypted `.env`-in-git via `dotenvx get`/`set` (ECIES)

### Brownfield UX
- `#`-prefixed informational service config no longer exec'd
- 1Password auth failures aggregate to one line instead of N
- `kit fix` auto-generates `.env.template` from `[secrets.keys]`
- `op signin` triggered automatically in `kit login / setup` when
  `secrets.store = "1password"`
- API-key patterns (Stripe, GitHub, AWS, GCP, Slack, JWT, OpenAI, Resend)
  redacted from `ServiceStatus.output` before audit / log persistence
- Interactive `kit init`: prompt for secret backend (9 options) instead
  of hard-coding 1Password; backend-specific `[secrets.keys]` syntax
- Plaintext-secret scan at init time: warns about credentials in `.env*`,
  `package.json`, `scripts/` with masked previews before backend is wired
- 1Password mode detection: `service-account` / `desktop-integration` /
  `eval-signin` / `no-account` / `not-installed` — actionable error per case

---

## Planned (post-flip, ordered by dependency)

Effort estimates assume one focused developer-day.

### Wire `[policy.agent_writes]` — DONE for `env_set`, audit + more ops remain
**The problem, as it stood.** `checkPolicy()` existed, was tested, and had no caller outside its own
module. `[policy.agent_writes]` was parsed, hashed into `KIT_POLICY_HASH` and travelled with the
repo — and gated nothing. `policy.ts` said the module "deliberately does NOT enforce — it just
SURFACES"; what was absent was step 2 of its own documented runtime contract, and the OWASP A01 row
implied an enforcement that never happened.

This was kept out of a release PR on purpose. It is an access-control surface whose semantics are
the opposite of the usual reading, and getting that wrong fails OPEN. The five traps, which are now
the structure of the test file:

1. **Empty list means deny, not allow.** `stripe = []  # all writes still gated` — kit's own
   example in `src/config.ts`. An implementer who treats an empty allowlist as "no restrictions"
   inverts the control for every operator who wrote it as a lock.
2. **Absent vendor vs present-but-empty must stay distinguishable.** `checkPolicy` already returns
   different reasons (`"no [policy.agent_writes] declared"` vs `"vendor not in [policy.agent_writes]"`);
   whatever consumes it must not collapse them, because one means "unconfigured" and the other means
   "configured to refuse".
3. **Which operations are gated, and what the vendor/op vocabulary is.** Today's example strings
   (`resolve_issue`, `rotate_jwt`, `env_set`) are illustrative, not a registry. A pre-approval list
   is worthless if the caller's op name and the operator's spelling can differ silently — the same
   defect class as the flag allowlist that rejected `--attest`. The op names need a single source
   both sides read, and an unknown op in the config should be surfaced, not ignored.
4. **Relationship to elevation must be explicit.** Pre-approval is not a substitute for the
   elevation gate. Decide whether it can only ever *narrow* (never grant past elevation) — the
   tightening-only property `hardwareRequired()` already models — and pin it with a test.
5. **Every branch needs a behavioural test that fails when the wiring is removed.** This defect
   survived because `checkPolicy` had unit tests proving the decision function correct while nothing
   called it. Tests over the decision function are not evidence of a working control.

**Done.** `policy-gate.ts` decides, `propagate()` enforces. The semantic chosen, and why: the block
is UNSIGNED config, so it may only ever NARROW — an agent that can edit `.kit.toml` must not be able
to self-approve by adding a line. `approval.ts` already holds the grant-shaped mechanism and it
requires an org-authority signature; that is the difference. So the enforcement point asks one
question only, "does policy refuse?", and there is deliberately no branch where an approval
satisfies a gate.

Four states rather than a boolean, so traps 1 and 2 cannot be collapsed by a consumer:
`inert` (no block) / `unconfigured` (block present, vendor absent — no opinion, because opting in
must be per-vendor or adding one rule takes every other vendor offline) / `approved` / `denied`
(vendor declared and op not listed, INCLUDING an empty list). A malformed entry — `vercel = "env_set"`
as a string — denies rather than reading as "no rule". `POLICY_OPS` is the single op vocabulary and
`unknownPolicyEntries()` surfaces a typo'd `env-set` instead of leaving the operator believing it
granted something.

Proof: `src/policy-gate.test.ts`, 18 tests grouped by the five traps above; mutation-proved three
ways — remove the wiring in `propagate` (2 fail), make an empty list permissive (5 fail), collapse
absent-vendor into a denial (5 fail).

**What remains, and it is not cosmetic:**

1. **Audit the enforced denials.** A policy refusal shows in the command's output but writes no
   `.kit-audit.jsonl` event. `checkPolicy` in `policy.ts` does the auditing and STILL has no
   production caller; the enforced path goes through the deliberately side-effect-free
   `policyDecision`. Reconciling the two is the next increment, and until it lands trap 3's promise
   of a forensic trail covering grants and denials is only half kept.
2. **Ops beyond `env_set`.** Coverage is the six propagation targets. `resolve_issue`,
   `rotate_jwt` and `trigger_deploy` are documented examples with no enforcement point; each needs
   a registry row and a choke point.
3. **Trap 4 is asserted, not proven end to end.** The tests show `policyRefuses` returns null for
   an approval and that the reason says so out loud. What is NOT tested is a live case where an
   approved op still gets stopped by elevation or read-only — that needs one of those gates in the
   same probe.

### Thread `cwd` through every check dimension — READ PATH DONE, write path remains
`runCheckGate` resolved its `cwd` option only to load `.kit.toml`. All ten dimensions after that
— `checkSecurity()`, `checkTools()`, `checkServices()`, `checkSecrets()`, `checkSkills()`,
`checkHooks()`, `checkTests()`, `checkWebSearch()`, `isGitRepository()`, and their callees —
resolved paths from `process.cwd()`.

**Done.** Every dimension that touches the filesystem now takes the governed project's `cwd`:
`checkSecurity(cwd)` threads it to all fifteen sub-checks *and* to all seven scanner spawns —
`trivy fs .`, `trivy config .`, `osv-scanner -r .` and `semgrep .` resolve `.` against the
SPAWNED process, so passing the path alone would have been the exact trap this entry warns about
below — plus `checkSecrets`, `checkHooks`, `isGitRepository`, `checkTests`, `loadBaselineForGate`,
`checkExternalFindings` and `checkGateLiveness`. The remaining four were measured to touch no
project path at all: `checkTools` resolves binaries on PATH, `checkSkills` reads an absolute
homedir path, `checkServices` and `checkWebSearch` neither. Proof:
`src/check-security-cwd.test.ts`, 8 tests, each asserting the two trees give DIFFERENT answers;
mutation-proved three ways (ignore the argument → 3 fail; revert one sub-check → 3 fail; drop
`cwd` from one scanner spawn → 1 fail).

**The write path is done too.** `cmdFix(cwd)` resolves the config, the `.gitignore` and the
relative `[secrets].template` against the governed project, and `lock.ts` had the asymmetry the
wrong way round — its readers (`readSkillsLock`, `readCliLock`, `readkitMeta`) all took a `cwd`
while its WRITERS (`writeSkillsLock`, `writeCliLock`, `writekitMeta`, `ensurekitDir`) did not, so
a caller read its own project's locks and wrote the process's. `installHooks` / `uninstallHooks` /
`resolveHooksDir` take it as well. Note that fixing `cmdFix` did NOT fix the MCP surface:
`register_kit_fix` carries its own copy of the lock step (it needs structured actions, not console
output), so it had to be threaded separately — the CLI-vs-MCP divergence this codebase has been
bitten by before. Proof: `src/fix-cwd.test.ts`, 6 tests asserting WHERE THE BYTES LANDED in both
trees; mutation-proved two ways (lock writers ignore `cwd` → 2 fail; `.gitignore` + template
resolve against the process → 3 fail).

**The audit destination is done too.** `withGovernance`, `runGoverned`, `logAuditEvent` and
`refuseWrite` all take a `cwd`, so a governed operation performed for B files its proof in B's
chain. This mattered because `exec-broker/broker.ts`'s own `audit()` docstring already explains
the cost: foreign-project evidence pollutes the host chain and poisons
`kit broker enforce-readiness`, "whose verdict is only as honest as the evidence file it reads". A
write served for B whose proof lands in A is not a write kit can stand behind. `logAuditEvent`'s
third parameter became an options bag in the process, which also makes the `companyId` the
`[governance.audit].remote` row is blocked on reachable — reaching it is still a separate decision
about where a company id comes from, not something to infer.

**`kit_review`'s collector is measured now, and it had one real gap.** `collectReview` passes
`opts.cwd` to all four stages, so it read as threaded — but `runDesignGate` passed that `cwd` to
`loadBaselineForGate` and then called `checkDesign(...)` without it, and `checkDesign` resolved its
source roots *and* every finding's display path from `process.cwd()`. The baseline came from B
while the files scanned came from A. A parameter that reaches one collaborator and not the next is
the same false green as no parameter at all, and reading `collectReview` alone would never show
it. Fixed, with `src/review-cwd.test.ts` (6 tests) and mutation proof both ways. The `check`,
`standards` and `adr` stages were already correct: all five standards runners receive the resolved
`cwd`, and `runAdrGate` threads it to `loadAdrs`.

Worth recording because it cost two false alarms: my first fixtures reported "the two trees are
identical" for the `adr` and `standards` stages and both times the FIXTURE was wrong, not the code
— an ADR in MADR heading style that kit's parser (YAML frontmatter with an `id`) correctly
ignored, and a standards stage whose five rows only measure tool availability, which two temp dirs
necessarily share. A probe that cannot tell the hypothesis from its negation is not evidence.

**The refusal is LIFTED**, and only after the end-to-end probe was run rather than because the code
read correct. A real MCP client was driven against a server whose `process.cwd()` was project A,
with each tool called for project B: `kit_check` reported B's missing `.gitignore` as `warn` where
it used to inherit A's `pass`; `kit_review`'s design stage described B's absent `src/`;
`kit_fix` created B's lock files in B, filed the `"operation":"fix"` audit line in B, and left A
with neither. The probe was run twice — once with the guard in place to confirm the baseline
refusal, once bypassed to measure what serving actually produced.

**The scanner subprocesses are proven for `semgrep`, by inference for the rest.** `semgrep .`
resolves `.` against the spawned process, so it is the direct test: one tree trips a local rule,
one is clean, and the verdicts must differ. It does. trivy, osv-scanner and guarddog ship as GitHub
release binaries and cannot be fetched in this environment (the session's policy answers 403 for
any repository outside its allowlist), so they rest on a chain of three — every `execFileNoThrow`
in `check-security.ts` passes `cwd: root`, the option demonstrably relocates a child process, and
semgrep demonstrably honours it end to end. Anyone with those binaries should re-run the
cross-project probe; the semgrep test skips loudly rather than silently when the binary is absent.

One write was found only by ENUMERATING the write surface, not by any probe:
`logSupplyChainFindings` appends bumblebee findings to `<root>/.kit-findings.jsonl` and was called
without a `cwd`. The reason no probe caught it is worth stating exactly, because the first version
of this note got it wrong: bumblebee IS provisioned here — kit downloads it to
`~/.kit/tools/bumblebee/<version>/` — and it does run (`pass`, 36 packages, on a clean fixture).
The write is gated on `findings.length > 0`, and a freshly created temp project has no known
exposures, so the branch is unreachable from any clean fixture. A green probe over a clean fixture
says nothing about the paths only a dirty one reaches.

Consequence, found with a discriminating probe over the MCP surface: `kit_check({cwd: B})` from a
server launched in A reported `pass — all .env patterns in .gitignore` for a project B that has no
`.gitignore` at all. The config came from B, the verdict came from A. `kit_fix` was worse — it
created B's lock files inside A.

Mitigated, not fixed: `kit_check` / `kit_review` / `kit_fix` now REFUSE a `cwd` that differs from
the server process's own directory rather than answering about the wrong tree
(`crossProjectRefusal` in `mcp-server.ts`), and `checkLockFiles` + the three lock readers now take
a `cwd` so `kit_context` stops reporting the server's lock state as the target project's. The
remaining nine dimensions still need the parameter before a cross-project call can be *served*
instead of refused.

Note when doing this: `src/mcp-server.test.ts` had four tests passing `cwd: tempDir` from a process
sitting in the kit repo — green only because of this bug, with one assertion conceding "ok depends
on repo-level security checks — test structure, not ok". They now `chdir` into the temp project.
Any dimension that gains a `cwd` needs a test that would FAIL if the parameter were ignored; a test
that merely passes `cwd` proves nothing, which is how this survived.

**Done, same class, separate surface:** the exec-broker's unsigned-policy path had the identical
bug, and there it was fail-OPEN rather than merely wrong-tree. `brokerPolicyPath()` resolved
`.kit-exec-broker.json` against `process.cwd()` while `brokerExec` measured writes against
`opts.cwd`, so a server in A mediating B ignored B's policy entirely — and since "no policy file"
means "not configured", the write ran unmediated with full env. The seven MCP tools NOT behind
`crossProjectRefusal` (`kit_secrets`, `kit_run`, `kit_triage`, `kit_init`, `kit_context`,
`kit_map`, `kit_memory`) do thread `cwd` correctly into their own callees — that is why they are
unguarded, and checking it walked back a suspected gap — but three of them route writes through
`runBrokered`, which was the hole. Fixed with 10 two-sided tests in
`src/exec-broker/policy-cwd.test.ts`; mutation-proved (dropping the `cwd` argument fails 6,
replacing the foreign-tree deny with `if (false)` fails 2).

### Shrink the inherited dependency surface — 120 installed, 9 loaded

Measured, and guarded by `src/mcp-dependency-surface.test.ts`: kit's four direct production
dependencies pull in 120 packages, of which `@modelcontextprotocol/sdk` alone accounts for **91**.
The SDK declares 17 hard dependencies with `optionalDependencies: {}`, including a whole HTTP
server and OAuth stack (express 5, express-rate-limit, cors, hono, `@hono/node-server`, raw-body,
content-type, eventsource, jose, pkce-challenge) for the Streamable-HTTP/SSE transports. kit speaks
stdio and **loads none of them** — traced across both module systems, at startup and during tool
calls.

Why it is a roadmap item and not just a curiosity: three of the four dependency advisories cleared
on the `cwd` branch came from that tree, and for a tool whose own pitch is supply-chain governance
— `kit triage` refuses untriaged installs — shipping ~12 never-executed webserver packages is its
own thesis pointed at itself. Each bump was correct; none of them touched the cause.

Four options, in the order I'd try them:

1. **Nothing, short term.** They are hard deps with no `optionalDependencies`, so npm installs the
   set regardless. Bumping is the only immediate answer, and that is what the branch did.
2. **Ask upstream** (`modelcontextprotocol/typescript-sdk`) to move the HTTP-transport and OAuth
   dependencies to `optionalDependencies`, or split them into a companion package. This helps every
   stdio server, which is most of them — the ask is not kit-specific. Draft below. **This cannot be
   filed from kit's own tooling:** GitHub access is scoped per session, and any repository outside
   the allowlist answers 403, so a human has to open it.
3. **Vendor the stdio transport.** It is newline-delimited JSON-RPC over stdin/stdout — small.
   Dropping the SDK would take the tree from 120 to roughly 29 packages. The cost is real: kit would
   own protocol conformance and lose `McpServer`'s registration and schema validation, which is a
   load-bearing dependency swap deserving its own costing, not a snap decision.
4. **Document and accept** — done: `docs/DATA_FLOW.md` and the A06 rows in `docs/OWASP_2025.md` now
   carry both numbers and the trace method.

Draft for (2), to be filed by hand:

> **Move the HTTP-transport dependencies to `optionalDependencies`**
>
> The SDK declares express, express-rate-limit, cors, hono, `@hono/node-server`, raw-body,
> content-type and eventsource as hard dependencies, plus jose and pkce-challenge for OAuth. A
> server that uses only `StdioServerTransport` installs all of them and loads none — verified by
> tracing ESM resolution and `Module._load` while booting a server, listing tools and calling two:
> 9 of 120 installed packages load, and none of the twelve above is among them.
>
> The cost lands on consumers as CVE noise in code they never execute. In one recent sitting a
> stdio-only consumer had to clear advisories in `hono` and in `ip-address` (via
> express-rate-limit) that were unreachable from its own code path, alongside one (`fast-uri`, via
> ajv) that genuinely was reachable — and telling those apart required tracing, because the
> dependency graph alone cannot.
>
> Moving the HTTP/OAuth set to `optionalDependencies` (or a `@modelcontextprotocol/sdk-http`
> companion) would let stdio consumers install what they run. Happy to send a PR if the shape is
> agreed.

### PR 2 — `kit analyze` subcommand (1d)
Walk git log + scan framework markers (`next.config.*`, `pyproject.toml`,
`Cargo.toml`, `drizzle.config.*`, etc.) to emit a draft `CLAUDE.md` + `RULES.md`
suitable for committing. Pure pattern-mining for v1; LLM-augmented version after PR 4.

### PR 3 — Security-policy enforcement (1d)
Translate dependency-allowlist policy into `.kit-allowlist.json` +
`kit security policy` subcommand that fails the build on un-allowlisted deps
and queries the GitHub Advisory DB. Builds on existing `check-security.ts`.

### PR 4 — LLM provider abstraction (2-3d)
Add an `src/llm/` module exposing a single `runLLM({provider, model,
messages, tools})` interface covering Anthropic, OpenAI, OpenRouter, xAI,
Google, Mistral, Ollama. Retry/failover, rate-limit cooldown, cost accounting.
Wire into `kit triage` (LLM-summarized risk) and `kit skills` (relevance ranking).

### PR 5 — Agent telemetry rollup (1d)
Per-agent tokens / cost / quality metrics. Append to existing
`.kit-audit.jsonl`; new `kit ops --rollup` subcommand for summaries.
Depends on PR 4 for cost-accounting hooks.

### PR 6 — DeepEval-style quality gates (1-2d)
`kit eval` subcommand running golden-case suites with G-Eval, AnswerRelevancy,
Faithfulness, TaskCompletion metrics. PR-blocking at configurable threshold.
Depends on PR 4 (LLM-as-judge).

### PR 1.5 — Extract `eas` to `sandstream-kit-plugin-expo` (0.5d)
Move EAS-secrets case from core to a plugin alongside other Expo-specific tooling
(EAS build, app.json validation, OTA updates). Backward-compat via plugin
auto-load when `eas-cli` is detected.

### Plugin lineup (1-2d each, parallelizable)

Based on a survey of several real-world projects. Each plugin bundles: CLI install
+ service config + MCP server registration + skills install + domain code.

| Plugin | Hits | Priority | Domain code |
|---|---|---|---|
| `sandstream-kit-plugin-supabase` | 4 projects | P1 | migrations, types-gen, local stack, RLS verify, seed mgmt |
| `sandstream-kit-plugin-next` | 2+ projects | P1 | env promotion, build/deploy hooks, ISR cache mgmt |
| `sandstream-kit-plugin-expo` | 1 project | P1 | EAS build, app.json validation, OTA updates + eas-secrets |
| `sandstream-kit-plugin-stripe` | 2+ projects | P2 | products/prices sync, webhook registration, test-mode switch |
| `sandstream-kit-plugin-resend` | 2+ projects | P2 | template deploy, domain verification, webhook mgmt |
| `sandstream-kit-plugin-netlify` | 1 project | P3 | deploy + env mgmt |
| `sandstream-kit-plugin-vercel` | 1 project | P3 | deploy + env promotion |
| `sandstream-kit-plugin-capacitor` | 1 project | P3 | native build, plugin sync |
| `sandstream-kit-plugin-playwright` | 1+ projects | P3 | trace mgmt, browser install pinning |

### Agent-config injection — "teach the agent to use kit" (1-2d)
Today `kit setup` writes only `.kit.toml`; wiring an agent to actually *use* kit
is manual copy-paste from `examples/agent-hooks/`. Add an **opt-in** setup step
(`kit setup` prompt + standalone `kit agent-config`) that detects the agent(s)
present and injects a **managed, idempotent block** (BEGIN/END markers, re-runs
update in place) instructing the agent to run kit:

  - **Claude Code** → append the block to `CLAUDE.md`; optionally register a
    `.claude/settings.json` PostToolUse hook running `kit check --category security`.
  - **Codex** → block in `AGENTS.md` (per `examples/agent-hooks/codex`).
  - **Cursor** → `.cursorrules`; **Cline** → `.clinerules`.

Default to the doc-block only (safe, just text the agent reads); the
settings.json hook (which makes kit auto-run on the user's machine) is a
separate explicit confirm. Never overwrite outside the managed markers.

### Integration with OneCLI (1d)
New `[secrets.store = "onecli"]` backend that registers placeholder keys with
the OneCLI gateway (https://github.com/onecli/onecli) for runtime credential
injection. Complements existing config-time backends — kit writes
`.env.local` with the fake keys; OneCLI swaps them at HTTP-request time so
agents never see real credentials.

### Encrypted-env & agent-auth backends (dotenvx, SOPS, VestAuth/as2)
kit stays vault-agnostic — new sources slot in as backends, new identities as
adapters, rather than adopting one opinionated stack. Candidates, by adoption × fit:

  - **dotenvx** (✅ SHIPPED) — `[secrets.store = "dotenvx"]`. Encrypted-`.env`-in-git
    (ECIES AES-256 secp256k1; public key in `.env`, `DOTENV_PRIVATE_KEY` kept
    separate). ~6.5M downloads/wk, the `dotenv` successor — highest user demand.
    Resolve a key via `dotenvx get` / `dotenvx run`; pairs with the existing
    plaintext-scan + migrate flow (encrypt in place instead of moving to a vault).
  - **SOPS + age** (P1) — `[secrets.store = "sops"]`. The other dominant
    encrypted-secrets-in-git tool (age / cloud-KMS / PGP). Resolve via `sops -d`.
    Covers the IaC / k8s crowd that dotenvx doesn't.
  - **VestAuth** (P2) — adapter `vestauth/identity` + a "sign, don't store"
    secret mode. RFC 9421 HTTP Message Signatures give an agent a cryptographic
    identity and sign requests instead of carrying a long-lived key — eliminating
    some secrets outright. Strongest story-match with kit's "keys on the loose" thesis.
  - **as2 — Agentic Secret Storage** (P3) — `[secrets.store = "as2"]`. Hosted
    agent-secret store accessed over a VestAuth identity (`vestauth agent curl`).
    Resolve-only (kit reads from it, like aws-sm/gcp-sm); depends on the VestAuth
    adapter, so it lands after P2.

Competitive note: dotenvx + as2 + VestAuth (all @motdotla, the `dotenv` author) form a
vertically-integrated agent-secrets stack. kit's edge is the horizontal layer — setup +
supply-chain triage + governance/elevation **on top of** whichever store you use.
Support them as backends; watch **as2** as the closest competitor to kit's
secrets-resolution core.

### Secret-migration wizard (2d)
New `kit secrets migrate` subcommand that turns the init-time plaintext
warning into an actual move:

  1. Re-scan via `scanPlaintextSecrets` to find current plaintext credentials
  2. Confirm target vault (re-read `secrets.store` from `.kit.toml`)
  3. Install vault CLI if missing (via mise) and trigger login
  4. For each finding: push value to vault → record ref in `[secrets.keys]`
  5. Replace plaintext in source file with the appropriate vault reference
     comment (or remove and rely on `kit secrets` to regenerate)
  6. Verify by re-running scan — expect zero findings post-migration

### Secret rotation (PR R1-R4, ~5-7d)
Production rotation orchestration. Replaces a key everywhere it lives.

  - **R1**: `kit secrets rotate <KEY>` — generate-new-via-source-API
    (Stripe roll-keys, AWS IAM create-access-key, GCP IAM service-account key
    create), write to vault.
  - **R2**: Multi-target propagation adapters:
    - Vercel (`vercel env add/rm`)
    - GitHub Secrets (`gh secret set`)
    - Fly (`fly secrets set`)
    - Cloudflare Workers (`wrangler secret put`)
    - Railway (`railway variables set`)
    - AWS Parameter Store (`aws ssm put-parameter`)
  - **R3**: Revoke / delete old credential after smoke-test passes against
    new credential; rollback on failure.
  - **R4**: History scrubbing — redact rotated key from `.kit-audit.jsonl`,
    surface git-history scrubbing via `git-filter-repo`/`bfg` for accidentally
    committed credentials (opt-in, destructive — requires explicit `--force-history`).

### Short-TTL backend re-auth detection (1d)
Cloud secret backends (AWS Secrets Manager, GCP Secret Manager, Azure Key Vault,
HashiCorp Vault) have session lifetimes from 1h (AWS STS) to 32d (Vault policy).
When a `op read` / `aws secretsmanager get-secret-value` / `gcloud secrets
versions access` fails with an expired-token error, kit currently surfaces
the raw error. Improvement: detect the expiry error code per backend, suggest
the right re-auth command (`op signin`, `aws sso login`, `gcloud auth login`,
`az login`, `vault login`), and offer to re-run after auth.

---

## Considered and rejected

- **Third-party CLI tool-version lockers and skill-loaders** — evaluated several
  overlapping early-stage projects; kit's mise integration + `cli-lock.json` and
  its skills system already cover the same ground more completely, so no external
  code was adopted.
- **Agent-lifecycle / event-timeline subsystems** — duplicate or conflict with
  kit primitives (RBAC, audit log). Out of scope for kit's environment-manager
  remit.

---

## Out of scope

kit stays a developer-environment manager. It does **not** intend to become
an agent runtime, an orchestrator, or a hosted service. Anything that requires
a daemon, a remote backend, or a multi-agent coordination layer belongs in a
separate project — most likely OneCLI for credential proxying, or a dedicated
downstream orchestrator.
