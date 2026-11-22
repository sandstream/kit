# CI & git-host enforcement

kit's gates live at four layers. **Layers 1–3 are client-side and host-agnostic**
(a pre-commit hook or a Claude Code `PreToolUse` hook does not care whether the
remote is GitHub, GitLab, or Bitbucket). **Layer 4 is server-side and is where
true org-level enforcement lives — and it is host-specific.**

| Layer | What | Host-agnostic? | Enforces or advises? |
| --- | --- | :---: | --- |
| 1. Git hooks (pre-commit/pre-push) — `kit hooks` | ✅ identical everywhere | Blocks locally, but bypassable (`--no-verify`, not installed) |
| 2. Native agent hook (Claude Code `PreToolUse`, …) | ✅ (local) | Can truly block, where the agent supports it |
| 3. Rules file + allowlist (`CLAUDE.md`/`AGENTS.md`/…) | ✅ | **Advises** (the agent runs the gate) |
| 4. Server-side / CI (branch protection + pipeline + pre-receive) | ❌ host-specific | **True org-level enforce** |

> Local layers are advisory or bypassable. **Only layer 4 enforces at the org
> level**, and it differs per host. Do not present a local hook as
> org-enforcement.

## The CI job (layer 4) — `kit ci`

`kit ci` is host-agnostic: it runs the checks, exits non-zero on failure, and can
emit a host-native report (`--format github` annotations, `--format gitlab`
JUnit). Drop it into any runner. Generate a ready pipeline snippet with:

```bash
kit ci --init gitlab        # prints a .gitlab-ci.yml job to stdout
kit ci --init bitbucket     # prints a bitbucket-pipelines.yml step
kit ci --init gitlab --write # writes the file (only if absent — never clobbers)
```

### GitHub

kit ships its own SHA-pinned Actions; a hand-written unpinned workflow would
(correctly) be flagged by `kit gha-audit`, so `--init` does not generate one. Run
`kit ci` in a job and make it a **required status check** on the protected branch
(Settings → Branches → branch protection rule → *Require status checks to pass*).

### GitLab

`kit ci --init gitlab` emits a `kit-ci` job (`kit ci --format gitlab` → JUnit
artifact `kit-report.xml`). Enforce it:

- **Required pipeline:** Settings → Merge requests → *Pipelines must succeed*.
- **Protected branch:** Settings → Repository → Protected branches.
- **Self-managed server-side (true enforce):** a [push rule] or a server
  [pre-receive hook] rejects the push itself — not bypassable by `--no-verify`.
  kit does not install these (platform-admin territory); run `kit ci` from them.

### Bitbucket

`kit ci --init bitbucket` emits a `kit ci` step. Enforce it:

- **Merge checks:** Repository settings → Merge checks → *Minimum successful
  builds* (≥1) so the pipeline must pass before merge.
- **Branch permissions:** Repository settings → Branch restrictions.
- **Data Center server-side (true enforce):** a pre-receive hook rejects the
  push. Same division of labor: kit runs in it; admins install it.

## What kit does and does not do

- **Does:** run as a host-agnostic gate (`kit ci`), generate GitLab/Bitbucket
  pipeline snippets, lint CI YAML for all three hosts (`kit gha-audit` covers
  GitHub Actions + `.gitlab-ci.yml` + `bitbucket-pipelines.yml`).
- **Does not:** install server-side/pre-receive hooks or branch-protection rules
  — those are platform-admin actions. kit documents the path; your admin wires
  the required check to the kit job.

## kit's own CI: affected tests (shadow mode)

This section is about the pipeline of this repository, not about `kit ci`.

The `build-and-test` job of `.github/workflows/ci.yml` runs every test on every pull request.
`scripts/affected-tests.mjs` computes which test files a change affects. It is wired in **shadow
mode**: the job still runs every test, and two extra steps only report. Neither step can fail the
job, and nothing about what CI proves has changed.

- Before the tests, the job summary gets one table row: the mode, the number of selected test
  files, the total, and the reason.
- After the tests, each test file that failed in the full run is listed as `would have caught` or
  `WOULD HAVE MISSED: <file>`. A miss is the evidence that the selection is not safe to switch on.

The selection is every test whose source imports a changed file, directly or through other files
(static `import`, `export … from` and dynamic `import()`; type-only imports are skipped because the
compiler erases them), plus `x.test.ts` for a changed `x.ts`, plus each changed test.

**Safeguard A: run everything when the selection cannot be trusted.** The mode is `all` when:

- a changed file is not under `src/` or `packages/*/src/` and is not a Markdown document, for
  example `package.json`, `package-lock.json`, a tsconfig, `.github/**`, `scripts/**`,
  `contracts/**` or `.kit-baseline.json`;
- a file under `skills/` changed, Markdown included;
- a `*.test-support.ts` file changed;
- a changed source file has more than 40 transitive importers (`--max-importers`);
- a changed file is not in the import graph, which is the case for a deleted or renamed file;
- the graph selects more than 200 test files (`--max-tests`);
- the diff is empty, or there is no merge base to diff against.

**Safeguard B: every push to `main` runs every test.** That is the existing behaviour of the same
job and it does not change.

**The known hole: a test can depend on a file it does not import.** Three cheap cases are detected
from the text of the test and of the `*.test-support.ts` files it reaches:

- A test that starts or reads the built program (`dist/cli.js` or another compiled module named
  by path) is selected whenever a non-test source file changes.
- A test that reads files and names `src` or `packages` paths is selected whenever a file under
  those directories changes.
- A test that reads files and names a document, its file name or its directory is selected when
  that document changes. A test that walks the tree for `.md` files is selected for every document.

A dependency outside these cases is not seen: a test that reads a file through a path built at run
time, or through a helper that is not a `*.test-support.ts` file. The shadow report exists to find
such tests before the selection decides anything.

Measured on 2026-11-22: 1114 test files; 218 start or read the built program and 57 read source by
path, 262 together. So a change to one source file selects at least 262 test files. 381 of the 772
source files have more than 40 transitive importers, so a change to any of them runs everything.

```bash
node scripts/affected-tests.mjs --worktree          # the selection for your branch and working tree
node scripts/affected-tests.mjs --files src/a.ts    # the selection for a list of files
node scripts/affected-tests.mjs --stats             # the counts above, measured now
```

[push rule]: https://docs.gitlab.com/ee/user/project/repository/push_rules.html
[pre-receive hook]: https://docs.gitlab.com/ee/administration/server_hooks.html
