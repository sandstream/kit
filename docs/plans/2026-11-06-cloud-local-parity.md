# Cloud and local parity: one tool pin, the same gate everywhere

> Steps use checkbox (`- [ ]`) syntax for tracking. Each phase lands as its own PR with green
> CI before the next starts.

**Goal:** A cloud agent session, the owner's Mac and CI run the same scanners at the same versions.
Then `kit review` and `node scripts/prepush.mjs` give the same answer wherever they run. Where a
tool is missing, kit says so as a setup gap, not as a failed check.

**Why:** in the cloud sessions of 2026-11-05 and 2026-11-06, `kit review` and `prepush` failed on
every PR for reasons outside the change: scanners not installed, `gh` not logged in, Semgrep missing.
That trained the session to read a red gate as "environment", which is the habit a gate exists to
prevent. The owner's Mac had a different gap: a Semgrep that is not CI's.

## Measured (2026-11-06)

| Tool        | Cloud session        | Owner's Mac (mise shims)    | CI (`security.yml`)      | Pinned in the repo?            |
| ----------- | -------------------- | --------------------------- | ------------------------ | ------------------------------ |
| kit         | present              | 7.2.1 (`npm -g`)            | built from source        | `package.json` (7.2.2 on main) |
| node        | 22                   | v22.23.4                    | 22                       | `.kit.toml`, `mise.toml`: `22` |
| semgrep     | **missing**          | **1.167.0** (CI is 1.183.0) | `semgrep==1.183.0`       | **workflow only**              |
| guarddog    | **missing**          | present                     | `guarddog==3.2.0`        | **workflow only**              |
| osv-scanner | **missing**          | present                     | **not installed**        | **nowhere**                    |
| gitleaks    | **missing**          | present                     | `gitleaks-action` v3.0.0 | **nowhere** (action version)   |
| trivy       | **missing**          | present                     | v0.76.1                  | `.kit.toml`, `mise.toml`       |
| lizard      | **missing**          | present                     | 1.24.0                   | `.kit.toml`, `mise.toml`       |
| gh          | present, **no auth** | logged in                   | `GITHUB_TOKEN`           | n/a                            |
| codex       | missing              | present                     | n/a                      | n/a (owner's tool, not kit's)  |

- **The root cause is two pin sources.** `.kit.toml [tools]` (mirrored in `mise.toml`) pins trivy,
  trufflehog, lizard, jscpd, scc, hadolint and license-checker. Semgrep and guarddog are pinned only
  in the workflow. osv-scanner and gitleaks are pinned nowhere a local install can read. A tool that
  `kit install` does not provision comes from the user's global mise, at whatever version it last got:
  that is how the Mac has Semgrep 1.167.0. `prepush` caught it and fell back to a venv the owner
  built by hand in `/tmp/semgrep-1183`. On macOS `/tmp` is cleared on reboot, so that fix does not
  last.
- **The cloud session has none of the scanners**, because nothing installs them: the repository's
  `.claude/settings.json` SessionStart hook runs only `kit hooks context`, and the environment has
  no setup script.

## Phases

### Phase 1: one pin source (not protected)

- [ ] Add `semgrep = 1.183.0`, `guarddog = 3.2.0`, gitleaks at CI's version and osv-scanner at a chosen one (CI does not install it today) to
      `.kit.toml [tools]` and `mise.toml`, with scheme-qualified refs so the triage gate can map
      them (`pipx:semgrep`, `pipx:guarddog`, `aqua:google/osv-scanner`, `aqua:gitleaks/gitleaks`).
- [ ] A test, `src/tool-pin-parity.test.ts`, reads `.github/workflows/security.yml` and fails when
      a version it installs differs from the `.kit.toml` pin. It reads the workflow and does not
      change it, so `.github/` stays untouched.
- [ ] `prepush` keeps its Semgrep version check. After this phase `kit install` provides the right
      Semgrep, and the hand-built venv is no longer needed.

### Phase 2: the cloud session installs what the Mac has (owner)

- [ ] **Setup script** in the cloud environment's settings (the environment menu in the session's
      title bar, then Edit, then Setup script). Owner only: it is not in the repository. Its content
      is short and comes from phase 1:
      `npm i -g sandstream-kit@<pinned> && curl https://mise.run | sh && kit install`.
      It runs once per environment image, not per session.
- [ ] **`gh` login:** a fine-grained token, read-only on the three repositories, as an environment
      secret. The setup script cannot read secrets, so the login happens in the session. This is
      the owner's call; without it, `kit review`'s GitHub checks stay a known gap, reported as one.

### Phase 3: a gap is reported as a gap (not protected)

- [ ] `kit doctor` and `prepush` print one line per missing or off-version tool:
      `semgrep 1.167.0, pinned 1.183.0: run kit install`. A missing tool becomes a setup step,
      not a failed check that someone learns to ignore.
- [ ] `prepush` ends with a separate count: _N failures in the change, M gaps in the environment_.
      `--strict` keeps failing on both.

## Not in scope

- Making the cloud session use the owner's Mac. Remote Control can attach a folder on a computer
  to a cloud session, but this plan is about a cloud session being able to check its own work.
- macOS in CI. No CI job runs macOS; the Mac column above is the owner's run, not a CI result.
