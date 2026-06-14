# kit GitHub Action

Add kit environment validation to any GitHub Actions workflow in two lines.

## Usage

```yaml
- uses: sandstream/kit@v1
```

### Full example

```yaml
name: CI
on: [push, pull_request]

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Validate environment
        uses: sandstream/kit@v1
        with:
          command: ci
          fail-on-warning: false

      - name: Build
        run: npm ci && npm run build
```

## Inputs

| Input | Description | Default |
|-------|-------------|---------|
| `command` | kit command: `ci`, `check`, `install`, `setup` | `ci` |
| `kit-toml` | Path to `.kit.toml` | `.kit.toml` |
| `fail-on-warning` | Exit 1 on warnings | `false` |
| `non-interactive` | No prompts | `true` |
| `working-directory` | Working directory | `.` |

## Outputs

| Output | Description |
|--------|-------------|
| `result` | Full JSON result from `kit ci --json` |
| `passed` | `true` if all checks passed |

## What it checks

When `command: ci` is used, the action runs `kit ci` which validates:

- **Tools** — required CLI tools are installed at the correct version
- **Services** — services are authenticated (Supabase, Stripe, Vercel, etc.)
- **Secrets** — required secrets are available in the environment
- **Lock files** — `.kit/skills-lock.json` and `cli-lock.json` are in sync
- **Security** — no hardcoded secrets, secure dependency versions

Failures emit `::error::` annotations directly on the PR. Warnings emit `::warning::`.
