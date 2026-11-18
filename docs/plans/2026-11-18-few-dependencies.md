# Few dependencies: build what kit needs, take in nothing for a few percent of it

> Steps use checkbox (`- [ ]`) syntax for tracking. Each phase lands as its own PR with green
> CI before the next starts. Phase 2 starts with a spike, and its result decides whether the
> replacement goes ahead.

**Goal:** Apply the global rule `few-dependencies` to kit itself. A library is taken in only when
it does something large or dangerous to write ourselves, kit uses a substantial part of it, and the
platform lacks the function. The target is the smallest shipped dependency tree that still does
the job: from 94 production packages to a handful.

**Why:** Peter, 18 November 2026. A review of a customer app found 1 449 known vulnerabilities in
about 2 500 packages, nearly all in build tooling and libraries the app used a small part of. The
risk of a library is not the part you use. It is the rest: code that comes along, must be updated
and can have faults, although the app never runs it.

## Measured before planning (2026-11-18)

- **kit installs 94 production packages and loads 9.** This is already guarded by
  `src/mcp-dependency-surface.test.ts` and written up in `docs/OWASP_2025.md` and
  `docs/DATA_FLOW.md`. The 94 are unique package names (96 counting versions) in the lockfile, not
  dev-only, not workspace links.
- **`@modelcontextprotocol/sdk` accounts for 91 of the 94.** kit speaks stdio and imports exactly
  `server/mcp.js` and `server/stdio.js`, in one production file, `src/mcp-server.ts` (825 lines,
  ten tools). The SDK declares 17 hard dependencies, including a complete HTTP server and OAuth
  stack (express 5, hono, jose, cors, raw-body and others) for transports kit does not use. This is
  the "5 percent" case exactly.
- **`@upstash/redis` was imported by nothing.** `src/adapters/upstash-redis.ts` calls
  `api.upstash.com` with `fetch`. The package shipped with one package of its own.
- **`smol-toml` (1 package, 18 files) and `zod` (1 package, 7 files)** are used widely and are
  small. TOML parsing is substantial work. Both stay unless a phase says otherwise.
- **123 of the 232 packages in the lockfile are development only.** The ESLint chain is the largest
  part, and it was the source of the `picomatch` advisory that blocked merges on 18 November. The
  per-dependency numbers are in Phase 3.
- **The 13 adapter packages have no runtime dependencies** (checked against the published
  manifests). Nothing to do there.

## Phase 1: remove `@upstash/redis` (done, #935)

- [x] Confirm nothing imports it, with the full repo searched (source, tests, scripts, packages).
- [x] Test first: the floor test lists three dependencies and fails against a manifest with four.
- [x] New guard in `src/dependency-floor.test.ts`: every declared runtime dependency is imported by
      production code. Mutation-checked: it names `@upstash/redis` when that is put back.
- [x] Remove the package. Amend ADR-0002. Change every "four runtime deps" claim and the 94 counts.
      `kit self-audit` rule R17 caught the last stale claim.

Result: 94 to 92 packages. Three runtime dependencies.

## Phase 2: replace the MCP SDK with kit's own stdio server (spike first)

The decision is Peter's. The recommendation is to run the spike and decide on its evidence.

- [ ] **Spike, one PR, nothing wired in.** A small server for JSON-RPC 2.0 over stdio, in its own
      file: `initialize` (with protocol version negotiation), `tools/list`, `tools/call`, `ping`,
      the notifications a client sends, and the standard error codes. No HTTP. No dependencies.
- [ ] **Conformance by test.** The tests keep `@modelcontextprotocol/sdk` as a development
      dependency and drive the new server with its own `Client` over a linked pair. Every one of
      the ten tools is called through both servers with the same input and the outputs are
      compared.
- [ ] **Stop signal.** Abandon the replacement if the spike needs more than about 400 lines, if a
      real client (Claude Code, Codex, the ChatGPT tunnel started by `kit mcp web`) behaves
      differently from the SDK server on `initialize` or `tools/list`, or if the read-only mode
      cannot be kept byte-for-byte.
- [ ] If it goes ahead: switch `src/mcp-server.ts`, keep `kit mcp --read-only` and `kit mcp web`
      unchanged, move the SDK to `devDependencies`, amend ADR-0002 to two runtime dependencies,
      and rewrite `src/mcp-dependency-surface.test.ts` (its loaded-set guard no longer applies).
- [ ] Redo the counts: 92 to about 2 shipped packages (`smol-toml` and `zod`).

**Risk.** This touches code that agents trust. A parse or framing error gives an agent a wrong
answer. The mitigation is the small surface, the conformance test against the SDK's own client,
and the stop signal above. Writing it ourselves also removes the SDK's HTTP stack from the
advisory list, but the stack was never loaded, so the gain is inherited surface, not a live path.

## Phase 3: the development tools (measured 2026-11-18, decisions open)

Measured from the lockfile on main (212 third-party package names reachable from the root, before
Phase 1): for each direct dependency, the packages it brings and the packages that are reachable
only through it.

| Direct dependency            | Kind | Brings | Only through it |
| ---------------------------- | ---- | -----: | --------------: |
| `@modelcontextprotocol/sdk`  | prod |     91 |              79 |
| `@upstash/redis`             | prod |      2 |               2 |
| `smol-toml`                  | prod |      1 |               1 |
| `zod`                        | prod |      1 |               0 |
| `eslint`                     | dev  |     76 |              56 |
| `tsx`                        | dev  |     29 |              29 |
| `typescript-eslint`          | dev  |     27 |              16 |
| `@types/node`                | dev  |      2 |               2 |
| `fast-check`                 | dev  |      2 |               2 |
| `@eslint/js`, `globals`, `prettier`, `typescript` | dev | 1 each | 1 each |

Candidates, in order of gain over risk. None is done. Each needs Peter's decision.

- [ ] **`tsx` (29 packages, all only through it).** It exists for one script, `npm run dev`
      (`tsx src/cli.ts`). That script is named in `CONTRIBUTING.md`, `docker-compose.yml`,
      `docs/ADAPTER_GUIDE.md` and `docs/MIGRATION_GUIDE.md`. Replace it with a build and `node
      dist/cli.js`, and change those four files. Node's own type stripping does not replace it
      directly: kit's imports end in `.js` while the files are `.ts`, and tsx is what maps one to
      the other. Gain: 29 dev packages. Cost: a slower edit loop.
- [ ] **`picomatch`, `fdir`, `tinyglobby` (3 packages, dev).** They exist only because
      `@typescript-eslint/typescript-estree` requires `tinyglobby`, which requires `fdir` and
      `picomatch`. `picomatch` has no patched release (GHSA-fc5q-39xc-vjpf, waived until
      2026-12-17). It cannot be replaced on its own. It goes only if `typescript-eslint` goes, or
      if a release of `typescript-eslint` stops needing it.
- [ ] **ESLint with `typescript-eslint` (about 100 packages, 72 only through them).** The largest
      development cost and the source of the picomatch advisory. First list which rules kit relies
      on and whether `tsc` strict, `kit standards` or `kit self-audit` already cover them. Replace
      only what is covered. This is the decision with the most gain and the most risk.
- [ ] **The Docker image carries its own copy of `picomatch`.** It is the copy bundled inside the
      global npm (`/usr/local/lib/node_modules/npm/node_modules/tinyglobby/...`), waived in the
      image scan until 2026-12-17. Plugin installs need npm, so it cannot simply be removed. The
      Dockerfile already swaps one bundled package by hand (`undici`); that route is closed here,
      because no fixed `picomatch` exists to swap in.
- [ ] Keep: `fast-check` (2 packages, 2 test files), `prettier`, `typescript`, `@types/node`
      (kept at 22, the Node floor), `smol-toml`, `zod`. Each is one or two packages that do real
      work.

**Known constraint.** `typescript-eslint` cannot run on TypeScript 7 yet (it refuses it, and
tracks support for 7.1). TypeScript 6.0.3 is the highest version the lint stack allows. A move to
TypeScript 6 changes every `tsconfig` (`"types": ["node"]`) and, because the release guard counts
workspace file changes, it must be done for the root package only. `@types/node` stays on 22 to
match the Node floor (`dependabot.yml` says so).

## Phase 4: keep it that way

- [ ] `kit check` or `kit self-audit` reports direct and total shipped packages at each larger
      change, as the rule requires. Decide where in a separate PR.
- [ ] A new runtime dependency needs the written justification the rule asks for: which package,
      which version, what it does, how much of it kit uses, and what would replace it.

## Phase 5: the same analysis as part of `kit review`, for any repository

Today `kit review` is check, design, standards, adr and skill. None of them answers "which of
these dependencies are heavier than the use we get from them". The nearest pieces are `kit check`
(advisories, pinned versions, cooling period), `kit supply-chain` (install-time triage), `kit sbom`
(a list) and `kit self-audit` (kit's own dead exports). The measurement in Phase 3 was made with a
throwaway script. It should be a deterministic, zero-LLM analysis that anyone gets when kit runs in
a repository, with a short list of what could be better.

- [ ] **What it reports (all from the lockfile and the source, nothing executed):**
  direct and total packages, split into shipped and development; for each direct dependency the
  packages it brings and the packages reachable only through it; a declared dependency that no
  source file imports; a dependency with a large closure and few import sites (the "5 percent"
  case); packages that need an older Node than the project's floor, or an engines range that pins
  the project to an old Node (the case that held a customer app on Node 16); several versions of the
  same package; packages with install scripts; advisories counted per direct dependency, so the
  heavy source of them is visible.
- [ ] **What it says it cannot see**, so a missing finding is never read as a clean one: dynamic
  imports, a tool used only from a script or a config file (`eslint`, `prettier`), and code reached
  through a re-export. A development tool is judged against `scripts` and config files, not only
  imports.
- [ ] **Advisory, not a gate, in the first version.** Findings carry a severity of `info` or
  `warn`. A gate comes only after it has run on several real repositories without false positives.
- [ ] **Ecosystems:** `package-lock.json` first (kit's own repository is the test case). `yarn.lock`
  second, because the app that prompted the rule uses it. Python and others later.
- [ ] **Validate on a second repository** before it ships: run it on a real app with a large tree
  and compare the numbers with a manual count and with `npm ls`.
- [ ] Where it lives: a stage of `kit review` and a category of `kit check`, decided in the first
  PR together with the ADR note that the rule `few-dependencies` is now measured by kit.

## Decisions

1. Phase 1: **done**, in #935.
2. Phase 2: run the spike? Recommended: yes.
3. Phase 3: measure only? Recommended: yes.
4. Phase 5: build the analysis into `kit review`? Recommended: yes, starting with kit's own
   repository and `package-lock.json`.

## Not verified

- The count of packages after Phase 2 (about 2) is an estimate from the lockfile, not a measurement.
- The ten tools' behaviour under real clients has not been compared with a replacement server.
