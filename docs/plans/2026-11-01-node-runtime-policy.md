# Node runtime policy: run on active LTS, support every LTS in support

> Steps use checkbox (`- [ ]`) syntax for tracking. Each phase lands as its own PR with green
> CI before the next starts.

**Goal:** Make kit follow, and then recommend, the Node.js setup that is safest:

- **Run** on the active LTS, latest patch, updated automatically. This covers CI, the Docker image and dev.
- **Support** every LTS line still in support, through `engines`.
- **Keep `@types/node`** at the support floor's major.
- **Test** both the floor and the active LTS.

Then ship deterministic checks so kit tells other repositories the same.

**Why now:** research in `sandstream/kit-research/docs/research/node-lts-policy-what-is-safest.md`, measured from nodejs.org's own release index on 2026-11-01.

- **Every Node security release since mid-2025 shipped to every supported line on the same day,** maintenance LTS included. So the exposure is patch lag and end-of-life lines, not maintenance vs active.
- **kit's own published Docker image** is digest-pinned to `node:22-alpine` = **Node 22.23.2** (built 2026-07-29). `.github/dependabot.yml` has no `docker` entry, so the image never received the 22.23.4 security release of 2026-10-20.
- **Dependabot PR #627** would move `@types/node` to 26 and `typescript` to 7. The first lets code use APIs the supported floor lacks. The second does not install, because `typescript-eslint` 8.72 requires `typescript <6.1.0`.

**State on 2026-11-01:**

| Line       | Status                        | Active support ends | End of life    |
| ---------- | ----------------------------- | ------------------- | -------------- |
| 26 Lithium | active LTS (since 2026-10-28) | 2027-10-27          | 2029-04-30     |
| 24 Krypton | maintenance LTS               | ended 2026-10-20    | 2028-04-30     |
| 22 Jod     | maintenance LTS               | ended 2025-10-21    | **2027-04-30** |
| 20 Iron    | end of life                   | —                   | 2026-04-30     |

## Decisions taken as defaults (change them in review)

- **The support floor stays `engines.node >=22`** until Node 22's end of life (2027-04-30). Raising it earlier refuses users who get the same security fixes, and buys nothing.
- **The Linux CI job tests 22 and 26.** Windows stays on the floor (22). Windows is the merge gate and the slowest job, so a second Windows line would double its cost for little new signal. Line 24 is covered by being between the two.
- **The Docker image moves to 26** only after the Linux job is green on 26.
- **Dependabot ignores semver-major updates** of `typescript` and `@types/node`. A major of either is a policy decision taken in a PR like this one, not a weekly bump.
- **The new kit checks warn and never fail.** None of them knows which runtime a team must keep for reasons kit cannot see.

## Global constraints

- **No new runtime dependency (ADR-0002) and no model client (ADR-0001).**
- **Every new check is a pure function with a sibling test.** Network data (the release schedule) comes through the reader kit already has in `src/upstream-runtimes.ts`. When it is unavailable, the result is `unverified`, never a pass.
- **No change to `flag-surface.ts` line count, which is frozen at 708.** A new check is a row in an existing command's output, not a new flag.
- **macOS is not covered by CI.** Any path-sensitive step says so in its PR.

## Phase 1: close the image's security gap

- [ ] Add a `docker` entry to `.github/dependabot.yml` (directory `/`, weekly), so base-image digests move with each patch.
- [ ] Re-pin all three `FROM node:22-alpine@sha256:` lines to the current digest. Verify the `NODE_VERSION` in its image config is the latest 22.x security release, and record it in the PR.
- [ ] Add `ignore` rules for semver-major updates of `typescript` and `@types/node` to the `npm` entry.
- [ ] Close #627 with a pointer to this plan, so Dependabot regenerates the group without the two majors.

## Phase 2: test the active LTS beside the floor

- [ ] Turn the Linux `build-and-test` job into a matrix over `node-version: ["22", "26"]`, keeping every existing step.
- [ ] Record any failure on 26 and fix it in kit code, not by pinning the test to 22.
- [ ] Keep a single required check name. Use an aggregator job if the matrix renames it. `kit gha-audit` flags a matrix job that can skip itself green.

## Phase 3: run the image on the active LTS

- [ ] Move the three `FROM` lines to `node:26-alpine@sha256:<digest>`, once Phase 2 is green on 26.
- [ ] Confirm the Docker workflow's build, scan and smoke steps pass, and record the image's `NODE_VERSION`.

## Phase 4: kit check, frozen base image

- [ ] A pure check: a Dockerfile `FROM <image>@sha256:<digest>` with no `docker` ecosystem in `.github/dependabot.yml` and no Renovate config is a **warn**: _"pinned by digest and nothing updates it, so security patches to the base image never arrive"_.
- [ ] Wire it where kit already reads Dockerfiles for the container gate. Fixtures:
  - digest pin plus no updater (warn);
  - digest pin plus `docker` in Dependabot (pass);
  - tag pin (left to the existing tag rule);
  - multi-stage files.
- [ ] Prove it on a copy of this repository at the commit before Phase 1, where it must fire.

## Phase 5: kit check, Node policy rows

- [ ] **End-of-life floor:** the lowest major in `engines.node` is past its scheduled end. **Warn.**
- [ ] **Types ahead of the floor:** the `@types/node` major is greater than the `engines.node` floor major. **Warn.**
- [ ] **Odd line in production:** a Dockerfile `FROM node:<odd major>`. **Warn.**
- [ ] **Run line behind:** CI `node-version` or a Docker `FROM node:<major>` on a maintenance line while an active LTS exists. **Info.**
- [ ] All four take the schedule from the existing reader. With no schedule they report `unverified`.

## Phase 6: raise the floor on Node 22's end of life

- [ ] On or after 2027-04-30: `engines.node` becomes `>=24`, `@types/node` moves to 24.x, and the CI floor and the Windows job move to 24. Add a CHANGELOG entry under a breaking-change heading.

## Done when

- The Docker image runs the active LTS and Dependabot moves its digest.
- CI tests the floor and the active LTS.
- `kit check` reports a frozen base image and the four Node policy rows, and kit's own repository passes them.

## Out of scope

- Policies for other runtimes (Python, PHP, Bun, Deno). The same split of run vs support applies, but each needs its own schedule source.
- Upgrading anyone's runtime automatically. kit reports; it does not change the version a repository runs.
