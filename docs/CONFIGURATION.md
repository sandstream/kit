# Configuration

**GENERATED** from `src/config-surface.ts` — run `node scripts/gen-config-doc.mjs` after adding a
section. `config-surface.test.ts` fails when a section exists in `kitConfig` and not in that table,
and when the table describes a section kit no longer has, so this reference cannot drift from the
code in either direction.

Everything below lives in `.kit.toml` at the project root. `kit config sections` prints the same
list in the terminal, marking which ones this repo already declares.

kit accepts **24 sections**.

| Section | What it configures | Set up with |
| --- | --- | --- |
| [`[agent_config]`](#agent_config) | How `kit agent-config` generates the rules files agents read (CLAUDE.md, AGENTS.md, …). | `kit agent-config` |
| [`[air_gap]`](#air_gap) | No-egress posture: mirrors, offline threat data, and offline provenance verification. | [docs](AIR_GAP.md) |
| [`[browser]`](#browser) | Browser-verification capability declaration. | `kit browser` |
| [`[context]`](#context) | The account and project each CLI must be pointed at, per tool. | `kit context check` |
| [`[coverage]`](#coverage) | Which standards the evidence map scores against. | `kit coverage --list-standards` |
| [`[decisions]`](#decisions) | Whether a run must leave a decision ledger — the choices it made where the spec was silent. | `kit decisions` |
| [`[deploy]`](#deploy) | Required platform env-var NAMES per project and environment. | `kit check --category deploy` |
| [`[env]`](#env) | Per-environment overrides of any section above. | — |
| [`[governance]`](#governance) | Whether agent operations are audited, under which environment, and the access/approval rules around them. | `kit governance` |
| [`[hooks]`](#hooks) | Git hooks kit installs, and the commands each one runs. | `kit hooks add secret-scan` |
| [`[mcp]`](#mcp) | Declared MCP-server connections for this project. | [docs](MCP_TOOLS_GUIDE.md) |
| [`[memory]`](#memory) | Memory capture and PAL behaviour, including this project's sensitivity class. | `kit memory` |
| [`[policy]`](#policy) | Which vendor writes an agent may perform, pre-approved by operation. | `kit governance` |
| [`[scan]`](#scan) | Scanner settings: which delegates run, the GuardDog toggle, a vault project for scanner tokens, and the client-exposed env allowlist. | `kit scan --list-delegates` |
| [`[secrets]`](#secrets) | Which vault backs this project's secrets, and the key names it needs. | `kit secrets` |
| [`[services]`](#services) | External CLIs this project authenticates against, with the login and check command for each. | `kit login` |
| [`[setup]`](#setup) | Project bootstrap commands — install dependencies, migrate, verify. | `kit bootstrap` |
| [`[skills]`](#skills) | Agent skills this project requires or offers, and the registry to fetch them from. | `kit skills` |
| [`[standards]`](#standards) | The deterministic dev-standards gate, and whether it fails on net-new findings. | `kit standards` |
| [`[supply_chain]`](#supply_chain) | Install-time triage settings — notably which package scopes count as internal. | `kit supply-chain` |
| [`[tools]`](#tools) | Tool versions this project requires, provisioned through mise. | `kit install` |
| [`[update]`](#update) | Whether kit surfaces a newer published version, and whether it may self-update. | `kit upgrade --self` |
| [`[version]`](#version) | Schema version of this file, as a top-level integer. | `kit config migrate` |
| [`[web]`](#web) | Web-search provider used by the features that need one. | [docs](PERFORMANCE_AND_DIAGNOSTICS.md) |

## agent_config

How `kit agent-config` generates the rules files agents read (CLAUDE.md, AGENTS.md, …).

**What it buys.** Every harness gets the same project rules from one source, so a rule added once reaches Claude Code, Codex and Cursor alike.

```toml
[agent_config]
user_rules = { include = true }
```

Set up with `kit agent-config`.

## air_gap

No-egress posture: mirrors, offline threat data, and offline provenance verification.

**What it buys.** The enclave's configuration is checked in and reproducible rather than living in one operator's shell environment.

```toml
[air_gap]
enabled = true
npm_registry = "https://npm.internal"
```

Fuller treatment: [`docs/AIR_GAP.md`](AIR_GAP.md).

## browser

Browser-verification capability declaration.

**What it buys.** kit can diagnose the local browser automation setup instead of a UI check failing for an unrelated reason.

```toml
[browser]
enabled = true
```

Set up with `kit browser`.

## context

The account and project each CLI must be pointed at, per tool.

**What it buys.** A tool answering as the wrong org becomes a red row instead of a filtered result set that looks complete — and a pre-push hook can block the wrong-project push outright.

```toml
[context.gcloud]
account = "me@example.com"
project = "acme-prod"
```

Set up with `kit context check`.

## coverage

Which standards the evidence map scores against.

**What it buys.** The coverage report covers the standards you are actually asked about, rather than all eight.

```toml
[coverage]
standards = ["asvs", "ssdf"]
```

Set up with `kit coverage --list-standards`. Fuller treatment: [`docs/STANDARDS.md`](STANDARDS.md).

## decisions

Whether a run must leave a decision ledger — the choices it made where the spec was silent.

**What it buys.** The review surface that survives when nobody reads the diff: kit requires the artifact and verifies its shape, and fails a governed run that recorded nothing.

```toml
[decisions]
require = true
```

Set up with `kit decisions`.

## deploy

Required platform env-var NAMES per project and environment.

**What it buys.** `kit check --category deploy` diffs the names your platform has against the names this repo needs — without reading a single value.

```toml
[deploy.vercel.environments.production]
project = "my-app"
required = ["DATABASE_URL", "STRIPE_SECRET_KEY"]
```

Set up with `kit check --category deploy`.

## env

Per-environment overrides of any section above.

**What it buys.** Staging and production differ in the file instead of in someone's memory.

```toml
[env.production.secrets]
store = "1password"
```

## governance

Whether agent operations are audited, under which environment, and the access/approval rules around them.

**What it buys.** Agent actions produce a hash-chained evidence trail, and destructive ones can require approval — the difference between trusting an agent and being able to show what it did.

```toml
[governance]
enabled = true
environment = "dev"
```

Set up with `kit governance`. Fuller treatment: [`docs/ENFORCEMENT_AND_AUDIT.md`](ENFORCEMENT_AND_AUDIT.md).

## hooks

Git hooks kit installs, and the commands each one runs.

**What it buys.** The floor runs before a commit or push instead of after review — a staged credential is refused while it is still local.

```toml
[hooks]
pre-commit = ["kit security scan-staged"]
```

Set up with `kit hooks add secret-scan`.

## mcp

Declared MCP-server connections for this project.

**What it buys.** The servers an agent may reach are declared and reviewable, instead of whatever each developer has wired locally.

```toml
[mcp.servers.github]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-github"]
```

Fuller treatment: [`docs/MCP_TOOLS_GUIDE.md`](MCP_TOOLS_GUIDE.md).

## memory

Memory capture and PAL behaviour, including this project's sensitivity class.

**What it buys.** What was decided survives the session, in a local store you own, classified so a restricted project is not indexed like a public one.

```toml
[memory]
default_class = "internal"
track_findings = true
```

Set up with `kit memory`. Fuller treatment: [`docs/MEMORY.md`](MEMORY.md).

## policy

Which vendor writes an agent may perform, pre-approved by operation.

**What it buys.** An agent's write is checked against a declared list at kit's choke points — and an empty list is a lock, not a wildcard.

```toml
[policy.agent_writes]
vercel = ["env:add"]
```

Set up with `kit governance`. Fuller treatment: [`docs/POLICY.md`](POLICY.md).

## scan

Scanner settings: which delegates run, the GuardDog toggle, a vault project for scanner tokens, and the client-exposed env allowlist.

**What it buys.** The scan set is declared instead of improvised, and a deliberately allowed exception carries its reason next to it.

```toml
[scan]
guarddog = true
delegates = ["osv-scanner", "trivy"]
```

Set up with `kit scan --list-delegates`.

## secrets

Which vault backs this project's secrets, and the key names it needs.

**What it buys.** Keys are declared by NAME and resolved from a vault, so a plaintext value never has to exist in the repo — and a missing key is a check failure, not a runtime surprise.

```toml
[secrets]
store = "1password"

[secrets.keys]
STRIPE_SECRET_KEY = { source = "1password" }
```

Set up with `kit secrets`. Fuller treatment: [`docs/ENV_FUELING.md`](ENV_FUELING.md).

## services

External CLIs this project authenticates against, with the login and check command for each.

**What it buys.** "Am I logged in to the right things?" becomes one command rather than a per-tool guess.

```toml
[services.github]
login = "gh auth login"
check = "gh auth status"
```

Set up with `kit login`.

## setup

Project bootstrap commands — install dependencies, migrate, verify.

**What it buys.** A fresh clone reaches a working state from one command, in the order the project actually needs.

```toml
[setup]
install = "npm ci"
verify = "npm test"
```

Set up with `kit bootstrap`.

## skills

Agent skills this project requires or offers, and the registry to fetch them from.

**What it buys.** Every agent working in the repo gets the same skills, pinned, instead of whatever each developer happens to have installed.

```toml
[skills]
required = { triage = "^1" }
```

Set up with `kit skills`. Fuller treatment: [`docs/SKILLS_ARCHITECTURE.md`](SKILLS_ARCHITECTURE.md).

## standards

The deterministic dev-standards gate, and whether it fails on net-new findings.

**What it buys.** Code standards are enforced by a gate with a baseline instead of by review memory.

```toml
[standards]
enforce = true
```

Set up with `kit standards`. Fuller treatment: [`docs/STANDARDS.md`](STANDARDS.md).

## supply_chain

Install-time triage settings — notably which package scopes count as internal.

**What it buys.** A first-party scope is not triaged as an unknown third-party package, so the gate stops crying wolf on your own code.

```toml
[supply_chain]
internal_scopes = ["@acme"]
```

Set up with `kit supply-chain`.

## tools

Tool versions this project requires, provisioned through mise.

**What it buys.** Everyone — and CI — runs the same versions, and `kit check` reports a drifted toolchain as a red row instead of a mystery failure.

```toml
[tools]
node = "22"
python = "3.12"
```

Set up with `kit install`.

## update

Whether kit surfaces a newer published version, and whether it may self-update.

**What it buys.** A pinned fleet stays pinned, and an operator who wants the banner keeps it — the choice is in the repo rather than in each shell.

```toml
[update]
check = true
```

Set up with `kit upgrade --self`.

## version

Schema version of this file, as a top-level integer.

**What it buys.** The config contract is frozen: kit can migrate an older file forward instead of guessing what an unknown shape meant.

```toml
version = 1
```

Set up with `kit config migrate`.

## web

Web-search provider used by the features that need one.

**What it buys.** Search runs through a provider you chose and can point at your own instance, rather than an implicit default.

```toml
[web.search]
provider = "brave"
```

Fuller treatment: [`docs/PERFORMANCE_AND_DIAGNOSTICS.md`](PERFORMANCE_AND_DIAGNOSTICS.md).
