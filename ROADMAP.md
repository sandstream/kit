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

### Wire `[policy.agent_writes]` — ENFORCED + AUDITED across kit AND the plugin write surfaces
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

Proof: `src/policy-gate.test.ts`, 31 tests grouped by the five traps above; mutation-proved ten
ways — remove the wiring in `propagate` (2 fail), make an empty list permissive (5), collapse
absent-vendor into a denial (5), stop auditing (4), audit every state including the silent ones (1),
audit into `process.cwd()` instead of the governed project (3).

**What remains, and it is not cosmetic:**

1. ~~Audit the enforced denials.~~ **Done.** `enforcePolicy()` decides via the pure
   `policyDecision`, then records refusals AND grants with the vendor, op, `policy_state` and
   policy hash, in the governed project's log. `inert`/`unconfigured` stay silent by design.
   `checkPolicy` now delegates its decision to the same function, so one rule has one
   implementation. Mutation-proved three further ways: stop auditing (4 fail), audit every state
   (1 fail), audit into `process.cwd()` instead of the governed project (3 fail).
2. **Ops beyond `env_set` — Supabase rotation done; plugin ops remain.** `scoped_key_mint` and
   `jwt_secret_roll` are registered SEPARATELY and gated at `secrets-rotate-cli.ts`, because their
   blast radii are not comparable — the roll invalidates every live token, and
   `elevation-scopes.ts` already treats them as distinct scopes for the same reason. A repo that
   pre-approved the reversible mint has not pre-approved the roll.

   Doing this exposed that kit's own documented example was wrong in two ways once the block became
   enforced: it named `rotate_jwt`, which is not an op, and `list_projects`, which is a READ inside
   a block called `agent_writes`. Both corrected in `config.ts` and `policy.ts`, and a test now
   parses the example out of `config.ts` and runs it through `unknownPolicyEntries` — so kit's own
   documentation cannot drift from the registry again.

   The `--mode` → op mapping was extracted to `supabaseRotationOp()` so it could be mutation-tested:
   inline it sat inside a function that needs the Supabase Management API to reach, so collapsing
   both modes onto one op would have been caught by nothing. Now it fails a test.

   ~~Still open: `resolve_issue`, `create_release` and `trigger_deploy` live in the plugins and have
   no choke point in kit.~~ **Done — and the plugin surface was worse than "no policy gate".**

   The plugins cannot be called from kit-core: they are standalone zero-dependency packages an agent
   imports directly, and `adapter-sdk` forbids importing kit-core (monorepo coupling + private-package
   leaks). So the enforcement point cannot be a function call. What crosses the boundary is the
   DECISION, not the config: kit resolves every registry op through `policyDecision` and exports the
   ones that came back `denied` as `KIT_POLICY_DENY` (`installPolicyEnv`, called from `main()` beside
   `installPolicyHash`). The plugin-side guard is then a membership test with no rule in it — nothing
   to collapse, no empty list to misread, no absent-vendor case to get backwards, because all four
   states resolved before the value was written. Serialising `[policy.agent_writes]` instead would
   have put seven independent implementations of the four-state rule in seven packages.

   It is exactly as strong as the `KIT_READ_ONLY` contract and no stronger: a process that never ran
   kit sees no denials. That is the containment model kit already documents, not a weakening
   introduced here, and absence must mean "no denial" or every `inert` repo goes offline the moment a
   plugin runs outside a kit invocation. A plugin-side refusal is NOT audited — a plugin has no path
   to the governed project's log; `enforcePolicy` still covers the ops kit itself gates.

   Registered and gated: `resolve_issue`, `create_release`, `trigger_deploy`, plus `env_unset`
   (separate from `env_set`: setting is recoverable by setting again, deleting destroys the only copy
   of a value and takes down whatever reads it), `api_token_revoke`, `webhook_create`,
   `webhook_delete`, and `scoped_key_revoke` — a THIRD Supabase op that was in neither the
   elevation-scope split nor the registry, because `secrets-rotate-cli.ts` only ever asks about
   `--mode`.

   **Four things this arc found by measuring rather than reading, in order of severity:**

   1. **`kit-plugin-supabase` had no containment guard at all.** Three write surfaces —
      `rollJwtSecret`, `revokeScopedKey`, `mintScopedKey` — no `assertNotReadOnly`, no policy check.
      Measured with `KIT_READ_ONLY=1` set and the client pointed at a local listener: all three sent
      their request and `rollJwtSecret` returned a rolled secret. The op kit's own registry describes
      as invalidating EVERY existing token was not contained by the gate the agent-containment story
      rests on, while six sibling plugins were. `cli.ts` even claims read-only is "honored [by] every
      kit-plugin write surface".
   2. **`unknownPolicyEntries()` had no production caller.** `config.ts`, `docs/OWASP_2025.md`,
      ROADMAP and CHANGELOG all described it as reporting to the operator; it reported to nobody.
      Measured: a repo with `vercel = ["env-set"]` (a typo) produced a full `kit check` with zero
      mention of it, exit 0 — and the typo silently INVERTS the operator's intent, because the vendor
      is now declared while its real op is not listed, so propagation is refused. This is trap 5 —
      "tests over the decision function are not evidence of a working control" — recurring one module
      after the arc that named it. Now the `policy agent-writes` row in `check-policy-ops.ts`, wired
      into `checkSecurity()` rather than `runCheckGate` so `kit ci` and `kit heal` see it too.
   3. **`kit knobs` advertised an op the registry rejected.** The knob description read
      `sentry = ["resolve_issue"]` while `resolve_issue` was not in `POLICY_OPS` — kit's own help
      text describing config kit's own checker flags. The drift test written for exactly this class
      hard-coded `config.ts`, so the same defect reappeared one file over. It now scans every source
      file that mentions the block.
   4. **The plugin test suites never ran.** 11 compiled test files, 76 tests — including every
      `KIT_READ_ONLY=1` refusal test the plugins do have — sat in `packages/*/dist/` while
      `scripts/test.mjs` collected only the root `dist/`. They pass; nobody was running them. A
      containment test that does not run is worse than none, because it reads as coverage.

   The gate that makes this class fail loudly: `src/plugin-write-gates.test.ts` derives the write
   surfaces from the plugin SOURCES rather than a maintained list — any function issuing a mutating
   request, or building a GraphQL `mutation` routed through a shared transport, must appear in the
   mapping with both guards in the documented order and an op the registry knows. Exemptions are
   named with reasons and asserted to still match something. Mutation-proved seven ways: drop the
   policy guard (1 fail), drop the read-only guard (1), swap their order (1), gate the token revoke on
   `env_set` instead (1), add a new ungated GraphQL mutation through the transport (1), loosen one
   plugin's read-only guard to `"1"` only (1), remove the registry row the revoke depends on (1).
3. ~~Trap 4 is asserted, not proven end to end.~~ **Done, and it turned up a fail-open.** Proving
   "policy narrows and never grants" needs a real gate that still stops an approved op — and the
   obvious candidate did not stop anything. Measured: with elevation satisfied (`KIT_ELEVATED=1`),
   `KIT_READ_ONLY=1 kit secrets propagate API_KEY --value x --to vercel` reached `spawn vercel` and
   failed only because the CLI is absent from the probe machine. Propagation writes a secret into a
   third-party control plane and nothing refused it.

   Root cause is a reasoning error in `read-only-surface.ts`, which omits `secrets` because it is
   "already refused inside their own modules". True of the LOCAL write
   (`writeSecretToBackend` → `refuseWrite`), false of propagation — one path's guarantee read as the
   module's. The exclusion comment now says so. Gated at `propagate()`'s choke point, checked once
   (the lock is session-wide) but reported per target so the operator sees what did not happen, and
   ordered BEFORE the policy gate so a lock-down answers "read-only" rather than "your policy is
   missing an entry". Three tests, mutation-proved two ways (remove the gate → 3 fail; let policy
   run first → 2 fail).

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

### Shrink the inherited dependency surface — 94 installed, 9 loaded

Measured, and guarded by `src/mcp-dependency-surface.test.ts`: kit's four direct production
dependencies pull in **94** packages, of which **90 are reachable ONLY through**
`@modelcontextprotocol/sdk` (91 via the SDK in total; without it the other three direct deps bring
4). Re-measured at SDK 1.30.0 — this section said 120/91 for the 1.29 tree, and the install count
moved under the `@hono/node-server` 1.x → 2.x bump while the LOADED count did not. The loaded number
is now asserted against this heading by the guard test, because a count that lives only in prose
drifts and a drifted number in a supply-chain argument is worse than no number.
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
2. ~~**Ask upstream**~~ **Done — the ask already existed, so kit added evidence instead of a
   duplicate.** [`modelcontextprotocol/typescript-sdk#1924`](https://github.com/modelcontextprotocol/typescript-sdk/issues/1924)
   ("Optional install of HTTP/SSE transport deps (express, hono) for stdio-only servers", open since
   2026-04-17) asks for exactly this, with the same three options. Filing the draft that used to sit
   below would have been a third "+1" on a thread that already had two.

   What kit contributed instead ([comment](https://github.com/modelcontextprotocol/typescript-sdk/issues/1924#issuecomment-5177704605)):
   the issue and its comment both argue from INSTALL counts, and nobody had shown which packages
   execute. kit's trace does — 9 of 94 load, all twelve HTTP/OAuth packages installed and none
   loaded — plus the argument that matters more than disk footprint: of the three advisories kit
   cleared from that subtree, `hono` and `ip-address` were unreachable while `fast-uri` (via `ajv`)
   was genuinely on the live path, and only a runtime trace can tell those apart. The SDK's tree is
   not all dead weight for a stdio consumer, which is why the ask is specifically about the
   separable HTTP/OAuth set rather than "fewer dependencies".

   A note that was wrong here for a day: this said the issue "cannot be filed from kit's own
   tooling — any repository outside the allowlist answers 403". Measured before acting on it:
   `gh issue list --repo modelcontextprotocol/typescript-sdk` exits 0. The 403 belonged to a
   different constraint (a cloud session's GitHub token is scoped to its one attached repo) and had
   been copied onto a local-session item where it did not apply. Worth remembering as its own
   defect class: a limitation recorded without the condition it depends on reads as permanent.
3. **Vendor the stdio transport.** It is newline-delimited JSON-RPC over stdin/stdout — small.
   Dropping the SDK would take the tree from 94 to 4 production packages (the other three direct
   deps' closure). The cost is real: kit would own protocol conformance and lose `McpServer`'s
   registration and schema validation, which is a load-bearing dependency swap deserving its own
   costing, not a snap decision.
4. **Document and accept** — done: `docs/DATA_FLOW.md` and the A06 rows in `docs/OWASP_2025.md`
   carry both numbers and the trace method.

The measurement, for anyone re-deriving it: a lockfile reachability walk from the four direct
production deps gives the install counts, and the loaded set needs BOTH module systems traced — a
`register()`ed ESM `resolve` hook and a `Module._load` patch. An ESM-only tracer reports 5 packages
and misses `fast-uri`, because `ajv` is CommonJS and reaches it through an internal `require()`. That
half-blind version was written first and produced a confident wrong answer, which is why the guard
test asserts it can see `fast-uri` BEFORE any of its absence claims are allowed to mean anything.

### Read the anchor record — N working trees currently give N green verdicts ([#470](https://github.com/sandstream/kit/issues/470))
`kit audit verify` answers for ONE working tree. Two real worktrees of this repo on the same commit
each report `✓ audit chain intact  1 entries`, exit 0 — two greens, neither of which is the whole
story, and no way to ask what the agents did to this repo today. That is not a defect in the `cwd`
arc above; it is that arc being right. `logAuditEvent` resolves against the governed project, and a
worktree IS a distinct working tree, so it correctly gets its own chain.

What survives the model was measured too, so this entry stays scoped: worktrees share the `.git`
common dir, so installed hooks fire in every one of them (an agent cannot create itself an ungated
worktree), and `.kit.toml` is tracked, so policy cannot drift and the narrowing-only semantic still
denies self-approval.

**The union data already exists.** `~/.kit/audit-anchor.json` keys the HMAC tip PER LOG PATH and is
shared across every tree on the machine — an index of every audit log kit has ever sealed here, 15
of them on the machine where this was measured. Nothing reads it that way: `audit anchor` seals the
`cwd` log, and the only reader outside `audit-anchor.ts` looks up a single path (`hints.ts:96`). So
the fix is a reader, not a gate — `audit verify --all` iterating the record, reporting **missing**
and **stalled** as distinct outcomes, because most of those 15 are short-lived test temp dirs and
alarming on both would make the command unreadable.

Second, smaller half: `elevation.ts` calls `appendAuditEventDirect` WITHOUT `cwd`, a call site the
`cwd` arc missed. It matters more than its size — `KIT_ELEVATED=1` is documented as the escape hatch
that "gets audit-logged loudly". The record is written; it lands in one of N logs no command reads
together. "Loudly" is a claim about a reader, and the reader is the weak link.

Found while researching agent session managers that give every session its own worktree, which turns
"N working trees on one machine" from an edge case into the normal case.

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
