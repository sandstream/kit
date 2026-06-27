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

[push rule]: https://docs.gitlab.com/ee/user/project/repository/push_rules.html
[pre-receive hook]: https://docs.gitlab.com/ee/administration/server_hooks.html
