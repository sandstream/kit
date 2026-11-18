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
  part, and it was the source of the `picomatch` advisory that blocked merges on 18 November.
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

## Phase 3: measure the development tools, change nothing yet

- [ ] Count the packages each development dependency brings (`eslint` with `typescript-eslint`,
      `prettier`, `fast-check`, `tsx`, `@types/node`, `typescript`), with the lockfile method used
      for production.
- [ ] Record, per tool, what kit would lose without it, and whether `kit standards` already covers
      it.
- [ ] Peter decides from the numbers. No removal without a decision.

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

## Decisions

1. Phase 1: **done**, in #935.
2. Phase 2: run the spike? Recommended: yes.
3. Phase 3: measure only? Recommended: yes.

## Not verified

- The count of packages after Phase 2 (about 2) is an estimate from the lockfile, not a measurement.
- The ten tools' behaviour under real clients has not been compared with a replacement server.
