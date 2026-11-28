# kit features

The full feature reference, moved out of the README so the README stays under npm's
package-page limit. The README keeps the overview; this page keeps the detail.

## Agent support and features

kit is **agent-agnostic** — it's a CLI that any coding agent can run, plus opt-in
adapters for the surfaces each agent exposes. Support today, per agent:

| Agent             | Memory index¹ |    "use kit" rules block²    |         Agent/MCP config audit³         | Perm allowlist⁴ | Auto-capture hooks⁵ | Blocking gate⁶ |
| :---------------- | :-----------: | :--------------------------: | :-------------------------------------: | :-------------: | :-----------------: | :------------: |
| **Claude Code**   |      ✅       |        ✅ `CLAUDE.md`        |   ✅ + commands/agents/skills/plugins   |       ✅        |         ✅          |    ✅ hook     |
| **OpenAI Codex**  |      ✅       |        ✅ `AGENTS.md`        | ✅ `.codex/config.toml` + `hooks.json`  |        —        |         ✅          |    ✅ hook     |
| **OpenCode**      |      ✅       |        ✅ `AGENTS.md`        | ✅ `opencode.json` + `.opencode/plugin` |        —        |          —          |   ✅ plugin    |
| **Cursor**        |      ✅       |      ✅ `.cursorrules`       |  ✅ `.cursor/mcp.json` + `hooks.json`   |        —        |          —          |    ✅ hook     |
| **Cline**         |      ✅       |       ✅ `.clinerules`       |                    —                    |        —        |          —          |    ✅ hook     |
| **Copilot**       |       —       | ✅ `copilot-instructions.md` |          ✅ `.vscode/mcp.json`          |        —        |          —          |       —⁸       |
| **Gemini CLI**    |      ✅       |        ✅ `GEMINI.md`        |       ✅ `.gemini/settings.json`        |        —        |          —          |    ✅ hook     |
| **Continue**      |      ✅       |              —               |                    —                    |        —        |          —          |      n/a⁷      |
| **Amazon Q**      |      ✅       |              —               |                    —                    |        —        |          —          |    ✅ hook     |
| **AWS Kiro**      |      ✅       |   ✅ `AGENTS.md` (shared)    |                    —                    |        —        |          —          |    ✅ hook     |
| **Factory Droid** |      ✅       |   ✅ `AGENTS.md` (shared)    |                    —                    |        —        |          —          |    ✅ hook     |
| **Aider**         |      ✅       |              —               |                    —                    |        —        |          —          |       —        |
| **Antigravity**   |      ✅       |              —               |                    —                    |        —        |          —          |    ✅ hook     |
| **Augment**       |       —       |   ✅ `.augment-guidelines`   |                    —                    |        —        |          —          |    ✅ hook     |

✅ supported · — not yet · n/a not applicable (no surface) ([#146](https://github.com/sandstream/kit/issues/146))

1. `kit memory index` parses the agent's local transcripts into the shared store.
2. `kit agent-config` writes the managed "run kit before installs / vault secrets" block into the agent's rules file.
3. `kit agent-audit` flags plaintext secrets, cleartext/inline-code MCP servers, and malware-shaped hooks in the agent's config. Generic `.mcp.json` / `.claude.json` are scanned for every agent regardless. In the project it reads `.claude.json`, `.mcp.json`, `.claude/settings.json`, `.claude/settings.local.json`, `.codex/config.toml`, `.codex/config.json`, `.codex/hooks.json`, `.cursor/mcp.json`, `.cursor/hooks.json`, `.vscode/mcp.json`, `opencode.json`, `opencode.jsonc`, `.gemini/settings.json` and `.factory/hooks.json`. The hooks in these files get the same malware-shape and project-script checks. The project audit also reads `.agents/skills` and `.codex/skills`. It also reads the user-level surfaces Claude Code and Codex load into every session (`~/.claude/skills`, `commands`, `agents` and `~/.claude/CLAUDE.md`; Codex's `AGENTS.override.md`/`AGENTS.md` in `$CODEX_HOME` and its skills in `~/.agents/skills` and `<codex home>/skills`) with the same rules plus `kit triage instructions`' rules, reported as warnings to read; and it names any model endpoint (`ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, the Bedrock and Vertex variants) that points away from the vendor, from the environment or a settings `env` block — host only, never the URL. A plain-HTTP endpoint fails; a third-party or local proxy warns, because it sees every prompt, tool result and secret. Last, it prints the skill posture: each skill in `.claude/skills`, Codex's `.agents/skills` and `.codex/skills`, and their user-level counterparts (`~/.claude/skills`, `~/.agents/skills`, `$CODEX_HOME/skills`), its `allowed-tools`, and whether the model and the user may invoke it, with undeclared values shown as the spec default.
4. kit can pre-authorize its read-only commands so they run without a prompt (Claude Code's `permissions.allow` today). Codex has a command allowlist too (`prefix_rule(..., decision="allow")` in `~/.codex/rules/` and `.codex/rules/`), which kit does not write or audit yet; for Codex `kit agent-config` writes a personal `codex --profile kit` preset (`approval_policy = "on-request"`, `sandbox_mode = "workspace-write"`) under `$CODEX_HOME` / `~/.codex` instead of committing a repo risk preference.
5. `kit memory install` registers lifecycle hooks so capture happens automatically in Claude Code (`~/.claude/settings.json`) and Codex (`~/.codex/hooks.json`). Codex requires review/trust through `/hooks` before new command hooks run.
6. A **true blocking gate** (deny an un-triaged install before it runs) uses the agent's pre-tool hook — `kit agent-config` wires it by default (`--no-install-gate` opts out) for Claude Code, Codex, Amazon Q, and Cursor (exit-2 hook commands); Gemini CLI with a stdout `{"decision":"deny"}` plus exit 2 (Gemini runs project hooks only in a trusted folder: `/permissions trust`); AWS Kiro, Factory Droid, Augment, and Antigravity via their hook/settings files (`.kiro/hooks/kit-install-gate.json` plus legacy `.kiro/agents/*.json`, `.factory/hooks.json`, `.augment/settings.json`, and a `kit-install-gate` entry in `.agents/hooks.json`); OpenCode via a generated `.opencode/plugin` that throws to block, in the form the installed version loads (1.0–1.3 get function exports, 1.4+ and 2.x a default `{ id, setup, server }`; kit reads the version from the install's package.json and never runs an `opencode` from the project); and Cline via an executable `.clinerules/hooks/PreToolUse` shim that gates every command of `run_commands`, and the list as one script, and blocks through Cline's `{cancel:true}` stdout contract (which stops the whole Cline run; macOS and Linux only, Cline on Windows runs only `PreToolUse.ps1`) — **11 agents** in all. `kit agent-config --user` writes the Claude Code gates into `~/.claude/settings.json` instead, so every checkout on the machine is gated. Cursor and Factory Droid entries fail closed (`failClosed: true`, `onFailure: "block"`), so a gate that crashes or times out blocks the call. Codex runs the hook only after you trust the project and the hook in Codex (`/hooks`); `kit agent-config` prints the steps, `kit check` warns (`codex install-gate trust`) until both hold, and kit never writes the trust itself. `kit agent-config` also marks `.codex/.kit-gate-installed` on the machine; if kit's gate later goes missing from `.codex/config.toml`, `kit check` fails (`codex install-gate liveness`) and names `kit agent-config` as the repair. Aider has no pre-tool hook and commits with `--no-verify` unless `git-commit-verify: true` is set; `kit check` warns (`aider git hooks`). The agent-agnostic enforcement floor is **git hooks** (`kit hooks`, pre-commit/pre-push) — they fire in any agent or none. See [#146](https://github.com/sandstream/kit/issues/146).
7. **Continue** exposes only a declarative tool-permission policy (`~/.continue/permissions.yaml` allow/ask/exclude) with no way to invoke an external command before a tool runs, so a kit blocking-gate adapter isn't possible there — git hooks + the rules-file block remain its floor.
8. **GitHub Copilot** (VS Code / Visual Studio): the "use kit" rules block is written to `.github/copilot-instructions.md` (wired when a `.vscode/` dir is present or the file already exists). Memory indexing and a blocking install-gate are not yet implemented — they need Copilot's transcript format and a pre-tool-hook surface verified against primary sources first. The git-hook floor + the MCP server (`kit mcp`, added to `.vscode/mcp.json`) apply today.

> The git-hook layer enforces at the VCS boundary regardless of agent; the rules-file block is **advisory** (it reminds the agent); only the blocking-gate hook **enforces** before an action runs.

**Saved permission rules.** `kit agent-audit` lists every saved allow, ask and deny rule it can read, one row each (harness, scope, file, rule, kind, a class from the lethal-trifecta tables, first-seen date): Claude Code's `permissions` in user, project, local and managed settings; Codex `prefix_rule(...)` in `$CODEX_HOME/rules/*.rules` and `.codex/rules/*.rules`, read as text and never evaluated; Cursor CLI's `~/.cursor/cli-config.json` and `.cursor/cli.json`; and Gemini CLI's `tools.allowed`, `tools.exclude`, `autoAccept` and `auto_edit`. A new allow rule or a removed deny or ask rule is reported against `~/.kit/agent-rules.json` until a person runs `kit agent-audit --accept-rules`. Antigravity, Copilot CLI and the other harnesses' rule stores are not read, and the output names them.

`kit check`, grouped status tables with a pass/fail summary:

```text
Tools
  ✓ node          22.22.2  (need 22)
  ✗ supabase      not installed  (need 2.78)
Services
  ✓ vercel        authenticated
Security
  ✓ .env gitignored      pass   all .env patterns in .gitignore
  ✓ pinned versions      pass   all dependencies pinned

7/8 checks passed  (1 issues)
Run kit install to fix tools, kit login to fix auth
```

`kit fix`, six remediation steps, then a fixed/manual summary:

```text
kit fix
──────────────────────────────────────────────────
[1/6] Tools        ✓ supabase  installed  v2.78.0
[2/6] Lock Files   ✓ Generated cli-lock.json
[5/6] .gitignore   ✓ Added 2 pattern(s) to .gitignore
[6/6] Git Hooks    ✓ Installed 1 hook(s): pre-commit

Summary
  ✓ Fixed 4 issue(s) automatically
  ! 1 issue(s) require human action:

HITL required
Blocker: stripe is not authenticated
Owner: provider admin
Why the agent cannot resolve this: auth / browser / external account
Do this:
1. Run `kit login --service stripe` in a normal terminal/browser session, or run `stripe login`.
2. Run `kit check --category services,secrets`.
Respond with: stripe configured/authenticated; no secret values pasted
Agent continues with: kit check --category services,secrets
```

`kit secrets`, resolves each key from the vault and writes `.env.local`:

```text
Generating secrets...  (env=dev)

  ✓ SUPABASE_URL        resolved  Derived from config
  ✓ STRIPE_SECRET_KEY   resolved  op://Development/Stripe/secret-key
  ✗ REVENUECAT_KEY      missing   not found in eas

  ✓ Wrote .env.local (from keys)
```

`kit triage <type> <target>`, security verdict before you install:

```text
Running triage on npm: left-pad

Health score: 7/10
Critical issues: 0
Warnings: 1
TRIAGE PASSED
```

Trust model documented in [`docs/THREAT_MODEL.md`](THREAT_MODEL.md);
data flow per command in [`docs/DATA_FLOW.md`](DATA_FLOW.md);
release-verification in [`docs/VERIFY.md`](VERIFY.md); how a release is cut, and
the migration off a long-lived npm token, in
[`docs/RELEASING.md`](RELEASING.md). kit's verdicts are
produced by deterministic code, never an LLM — a CI-enforced contract, see
[`docs/ZERO_LLM_CONTRACT.md`](ZERO_LLM_CONTRACT.md).

- `kit doctor`: Deep diagnostics: Node.js version, mise, .env.local, tools in PATH, git hooks, **which hosts the triage gate points at** (public defaults vs internal mirrors / GitHub Enterprise — offline, so it never claims the hosts are _reachable_; it warns when `[air_gap]` is enabled while probes still point at public registries), and **OS containment posture** — detects the sandbox _below_ the tool boundary (container / seccomp / user-ns, gVisor / Firecracker fingerprints, and a VM guest from the x86 `hypervisor` CPU flag) and reports it honestly (`unknown` on non-Linux, never a false "not contained"), including whether the boundary **shares the host kernel** (container, seccomp) or is a **separate kernel** (gVisor, a VM). A VM guest is reported but not counted as containment. Set `[governance.containment] require = true` to make it a **fail-closed gate**: doctor fails when containment can't be positively established (including when it can't be determined). kit detects/verifies a sandbox — it never becomes one
- `kit env`: Inspect environment variables from .env.local (`--show-values`, `--missing`, `--json`)
- `kit mcp`: Run the MCP server over stdio for AI assistants (auto-detected: no sub-command + non-TTY). Interactively, `kit mcp list|auth|set-token|clear` manages declared servers
- `kit analyze`: Detect stack + emit draft `CLAUDE.md` / `RULES.md` from git history + framework markers

### Secrets management

End-to-end secret lifecycle, from `.env*` plaintext discovery, through vault
migration, to deploy-platform propagation, to destructive history cleanup.

- `kit secrets`: Materialize `.env.local` from the configured vault store
- `kit secrets set <KEY> --stdin | --value <v>`: Capture a value straight into the vault (stdin-safe, never in argv). The execution behind a service's `auth = "capture"` strategy
- `kit secrets migrate`: Move plaintext credentials from `.env*` into the vault
- `kit secrets rotate <KEY>`: Mint a new value (`--random` opaque token / `--value <new>` explicit)
- `kit secrets rotate <KEY> --from-cli`: Provider-native playbooks (Stripe / AWS-IAM / GCP-IAM / GitHub PAT / OpenAI)
- `kit secrets rotate <KEY> --via supabase-mgmt-api --project <ref>`: Full automation via Supabase Mgmt API. Auto-detects scoped-key-mint vs jwt-secret-roll. `jwt-secret-roll` is legacy (its endpoint is no longer in Supabase's published API); prefer `signing-key-cutover` below.
- `kit secrets rotate <KEY> --via supabase-mgmt-api --mode signing-key-rotate|signing-key-cutover`: Rotate the project's JWT signing key (Supabase's successor to the JWT secret). Reversible: the old key keeps verifying what it signed. `signing-key-cutover` also revokes it, so its tokens stop verifying; that takes a one-shot elevation. Nothing is written to the vault, since the private key stays with Supabase. A cutover refuses a project with no signing key in use, because it would revoke nothing: migrate the JWT secret to signing keys first.
- `kit secrets propagate <KEY> --to vercel,github,...`: Push value to deploy targets (stdin-safe via `--stdin`)
- `kit secrets revoke-old --via supabase-mgmt-api --key-id <id>`: Revoke a previously-minted scoped key
- `kit secrets onecli register <KEY> --host <pattern>`: Register with the OneCLI gateway so the agent process never sees the real value
- `kit secrets list [--backend <name>] [--json]`: Key names per backend, with the `<KEY>_EXPIRES_AT` hint and the last rotation kit recorded. Never reads a value
- `kit secrets incident <backend> [--since <ISO>] [--verify] [--new-snapshot]`: Vendor-incident response. Prints each key's rotation command (`--from-cli`, Supabase, or manual), then an **evidence plan**: per key, the command that fetches the store's own access record since `--since` (AWS CloudTrail `GetSecretValue` and KMS `Decrypt` lookups with the 90-day Event history limit, the GCP `AccessSecretVersion` Data Access query with the note that those logs are off by default, the Azure Key Vault `SecretGet` AuditEvent query, the 1Password Events API item usages and the Infisical audit-log API), each checked against the vendor documentation it cites; Vault, Doppler and Bitwarden are marked "not verified" with no command; `env`/`config` keys have no store-side record; plus `kit audit secrets --key <NAME> --since <ISO>` for kit's own record. Printed only, never run. A missing event proves only "not read through that service". It also names the CLI binary the values are read through, and writes a fingerprint snapshot (HMAC-SHA256 under a random per-snapshot key, owner-only, in gitignored `.kit/incident/<backend>.json`). The key is not in the snapshot: it lives per user at `~/.kit/incident-keys/<project-id>/<backend>.key` (owner-only, no symlinks, refused inside the repo), and the snapshot holds only a key id, so a leaked snapshot cannot be used to test guesses or verify on its own. `--verify` re-reads every value: exit 0 only when every key changed. A value it cannot re-read is "not verified", never "changed", and a missing, widened, corrupt or re-keyed snapshot, or a missing, widened or mismatched key, is an error, not a silent re-snapshot; only `--new-snapshot` creates a new key, and it is audited. kit does not rotate remote credentials in a batch: minting and revoking stay a person's step. It is a plain CLI, so it works the same from Claude Code, Codex or a terminal
- `kit secrets purge-history <pattern> --force-history`: Destructive: rewrite git history to scrub a leaked value (wraps `git filter-repo` / `bfg`). Requires elevation + explicit flag.

### Deploy env matrix

Declare deploy-time key names in `.kit.toml`; commit names, never values. `kit check --category deploy` lists remote key names from the platform and diffs them against the declaration. With `VERCEL_TOKEN`, `project` is the active Vercel project name/id selector; without a token, kit falls back to the Vercel CLI and the target `cwd` link. `NEXT_PUBLIC_*` keys are treated as build-time: after setting one, redeploy before expecting the running frontend to see it.

```toml
[deploy.vercel]
scope = "example-team" # CLI fallback scope
team_id = "team_123"   # API selector when VERCEL_TOKEN is present
environment_specific = ["NEXT_PUBLIC_SITE_URL"]

[deploy.vercel.environments.production]
project = "app-prod"
remote_env = "production"
required = ["NEXT_PUBLIC_SENTRY_DSN", "NEXT_PUBLIC_SENTRY_ENVIRONMENT"]

[deploy.vercel.environments.staging]
project = "app-stg"
remote_env = "production" # separate staging project; use "preview" for preview builds
required = ["NEXT_PUBLIC_SENTRY_DSN", "NEXT_PUBLIC_SENTRY_ENVIRONMENT"]
```

**Which vault CLIs kit installs.** When you pick a secret backend at `kit init`, kit
provisions its CLI like any other tool — it adds the CLI to `[tools]`, so `kit setup`
installs it via mise, resolves it mise-first at read time, and prints the login step.
This covers the dedicated vault CLIs:

| Backend             | CLI installed by `kit setup`?            | Authenticate with                    |
| ------------------- | ---------------------------------------- | ------------------------------------ |
| 1Password           | yes (`op` via mise)                      | `op signin`                          |
| Infisical           | yes (`infisical` via mise)               | `infisical login` + `infisical init` |
| Doppler             | yes (`doppler` via mise)                 | `doppler login` + `doppler setup`    |
| Bitwarden           | yes (`bw` via mise)                      | `bw login` + `bw unlock`             |
| HashiCorp Vault     | yes (`vault` via mise)                   | `vault login`                        |
| AWS Secrets Manager | **no** — uses your existing `aws` CLI    | `aws configure` / IAM role           |
| GCP Secret Manager  | **no** — uses your existing `gcloud` CLI | `gcloud auth login`                  |
| Azure Key Vault     | **no** — uses your existing `az` CLI     | `az login`                           |

The three cloud secret managers are a deliberate exception: their CLIs are normally
already present (cloud installer, CI image, IAM environment), authenticate through
cloud-native mechanisms rather than a CLI login, and a second mise-managed copy could
shadow the system one. kit therefore **guides** their login but does not install the
CLI — it resolves the binary from your `PATH` and falls back cleanly if absent. Logging
in to any vault is always your own account action; kit never does it for you.

### Security scanners

- `kit security scan-staged`: Pre-commit: scan staged blobs for known credential patterns; only findings the commit introduces block it
- `kit security scan-build`: Walk `.next/`, `dist/`, `build/` for credentials inlined into artifacts (`NEXT_PUBLIC_` typos), Electron `app.asar` archives included (read as bytes, up to 1 GiB). Files of other types are not read, and the output counts them by extension
- `kit security scan-transcripts`: Scan supported text files in project agent directories and matching Claude, OpenCode, and Codex project caches.
  Kit reports unreadable files, size limits, and other gaps. The command succeeds only after a complete scan with no findings.
  The scan excludes the machine-wide Codex sessions store and agent worktree copies.
- `kit check` row `local docker image IOCs`: Compare image names and registry digests in the selected Docker context with published indicators.
  Kit checks the list against the daemon image count. The check does not scan image content.
- `kit check` reads findings from `.kit-scan-results.jsonl` when the file exists. Kit reports unreadable or invalid reports and keeps usable findings.
  The file cannot prove that the external scanner completed its scan or that the records are recent.
- `kit security check-gitignore [--fix]`: Verify `.env*`, `*.pem`, `id_rsa`, `.kit/elevation.json` are ignored
- `kit security verify-pull [--base <ref>]`: After `git pull`: audit new deps, gitignore drops, introduced secrets, policy changes
- `kit security policy [init|add <pkg>|check]`: Dependency allowlist enforcement + per-key spend caps/TTL/scope
- `kit security costs`: Snapshot per-key spend vs policy cap (Stripe live; OpenAI/Anthropic/Resend/Vercel stubbed)
- `kit security routes [--json]`: an inventory of routes to review, not a verdict; it always exits 0. It lists Express, Fastify and Hono routes registered by call in a file that imports the framework (`app.get("/x", …)`, `router.route("/x").get(…)`, `fastify.route({ url, method })`), Next.js app router `route.*` and `page.*` and pages router files, and SvelteKit `+server.*`, `+page.svelte` and form actions, when a package.json declares `next` or `@sveltejs/kit`. A route is listed when its path has an id parameter (`:id`, `:userId`, `[id]`), names admin, login, signin, signup, register, reset or password, or its file imports an AI SDK (openai, @anthropic-ai, ai, @ai-sdk, @google/generative-ai, @google/genai, @mistralai, cohere-ai, groq-sdk, langchain, ollama, replicate and a few more). Column "auth guard seen": a guard name such as `requireAuth`, `isAuthenticated`, `authenticate`, `protect`, `withAuth`, `passport.authenticate`, `jwt()`, `bearerAuth`, `clerkMiddleware`, or a session call (`getServerSession`, `auth()`, `currentUser`, `req.session`, `locals.user`) in the route's call or file, in an earlier `use()`/`register()`/`addHook()` in the same file, in Next.js `middleware`/`proxy` and `layout` files, or in SvelteKit `hooks.server` and `+layout.server`. Column "rate limiter seen": express-rate-limit, express-slow-down, rate-limiter-flexible, @upstash/ratelimit, @fastify/rate-limit, hono-rate-limiter, @arcjet, a Fastify `rateLimit:` config, or a name containing `limiter`/`rateLimit`. Neither column decides coverage: an empty one means no known name was seen, and a name seen does not prove it covers the route. Not covered: router mount prefixes and runtime paths, handlers imported from another file, middleware matchers, Next.js server actions and rewrites, and other frameworks (Koa, NestJS, tRPC, Remix, Nuxt, Astro, non-JS)
- `kit security clear-cache`: Reset the cached supply-chain scanner binary (use after an intentional rebuild)
- `kit check` row `anonymous database access`: reads `CREATE POLICY`, `GRANT` and `REVOKE` in the project's SQL files, in file name order, and lists the tables that anon or public can select from. A table with a phone, email, person name or national id column fails; a column-level `GRANT` limits what counts. On a Supabase project (`supabase/config.toml`, or `@supabase/supabase-js` or `supabase` in `package.json`) it also lists each table created in `public` without row level security enabled, because Supabase grants new `public` tables to `anon` by default; `REVOKE … FROM anon` and `ALTER DEFAULT PRIVILEGES … REVOKE … FROM anon` count, and other schemas are skipped. It reads files only and contacts no database
- `kit check` row `signed-in database access`: from the same read of the SQL files, lists each table where a permissive `CREATE POLICY … FOR SELECT` (or `FOR ALL`) `TO authenticated USING (true)` lets every signed-in user read every row. On Supabase anyone can sign up, so that is close to public. It warns (medium), and fails at high only when the table has a personal-looking column, by the same column rule as `anonymous database access`. A table anon can already read stays on the anon row, and a table declared under `[anon_access.public]` with a reason and no personal column is accepted. Restrictive policies that might narrow the permissive one are not combined. It reads files only and contacts no database
- `kit check` row `firebase security rules`: reads `firestore.rules` and `storage.rules` at the project root and every `rules` path `firebase.json` names under `firestore` or `storage`. It fails on an `allow` that has `if true` or no condition (critical when it opens `write`, `create`, `update` or `delete`), and warns on `if request.auth != null` over a wildcard match such as `/{document=**}` or `/{coll}/{doc}`, because any signed-in user then reads every document. Comments are ignored, a statement may span lines, nested `match` paths are joined and `function` bodies are skipped. Limits: a condition is compared as text, so a function that returns `true` and `true || …` are not resolved, test-mode `request.time < timestamp.date(…)` rules are not flagged, only the project root is read, and Realtime Database rules (`database.rules.json`) are not read. A named path outside the project, a missing named file or a file it cannot finish makes the row incomplete. It skips when the project has no rules file
- `kit check` row `instruction-file secrets`: reads every file a coding agent loads as instructions, from kit's one instruction-file list (the one `kit triage instructions` uses), with kit's shared secret patterns. That covers Claude Code (`CLAUDE.md`, `CLAUDE.local.md`, `SKILL.md`, `.claude/rules`, `commands` and `agents` `**/*.md`), Codex (`AGENTS.md`, `AGENTS.override.md`), Cursor (`.cursorrules`, `.cursor/rules/*.mdc`), Gemini CLI (`GEMINI.md`), GitHub Copilot (`.github/copilot-instructions.md`) and Windsurf (`.windsurfrules`), in any letter case. A match fails at critical and names the file and the pattern, never the value. A file it could not read, or a walk limit it reached, makes the row an incomplete scan instead of a pass. `kit agent-audit` reads agent configs and `kit triage instructions` reads these files for injection; neither looked for keys in them
- `kit check` rows `instruction rules naming missing code` and `instruction rules removed since HEAD`: read the same instruction-file list for rule lines, the lines with "never", "must not", "do not", "don't", "always", "must", "only", "forbid" or "avoid". Both warn (low) and never fail. No model is used.
  - **Naming missing code.** A rule line's backticked code token is looked up: a path (resolved next to the instruction file, then from the root), an identifier (`legacyHandler()`, `Guid.NewGuid()`, `enforced_by`), or an env var. Commands (anything with a space), URLs, flags, `node:` specifiers, absolute and home paths, placeholders (`<target>`, `NNNN_slug.sql`) and plain words are skipped. A token is listed only with evidence that it named code here:
    - a path that is gone but is in git history (`deleted`);
    - a name that is in `HEAD`'s code but not in the working tree (`removed`);
    - a path that is not in the tree, under a rule that requires it (not "never"), inside a directory that exists (`missing`).
      An absent name under "never" is the rule obeyed, and an absent bare file name is often one the agent is told to write, so neither is listed without that evidence. Git-ignored paths are skipped.
      The search is bounded and run once per check: 50,000 tree entries; 20,000 code files of at most 1 MB and 64 MB in all, with prose (`.md`, `.txt`) and instruction files excluded; 100 history lookups. A bound reached makes the row an incomplete scan. A name removed in an earlier commit is not found: the row is meant to run before a commit.
  - **Removed since HEAD.** Each instruction file that differs from `HEAD` (`git diff`, read-only) has its committed strong rule lines compared with the working tree's version of the same file. A line that is gone is `removed`. A line whose "never", "must" or "always" became "avoid", "prefer not", "should" or "try to" is `weakened`. A line that only moved, was reflowed or reworded with its strong word kept (three in five words shared) is not listed. A rule moved to another file is listed, because each harness reads its own file. Line numbers are `HEAD`'s. Outside a git work tree with a commit the row skips.

### Self-audit

`kit self-audit` runs kit against its own source. It is zero-LLM and deterministic (walks `src/*.ts`, no network), so it can gate in CI. Two jobs in one: it scans for the same bug-classes the wider audit catches (reintroduced `|| true`, unguarded dynamic imports, and the rest of the rule set), and it asserts that every script referenced from `.github/workflows/*.{yml,yaml}` (node/python files, `npm run` targets) actually exists, so a workflow can never point at a missing script.

- `kit self-audit`: Run every enabled rule; print findings (text by default; `--format=github` / `--format=gitlab` / `--format=json` for CI)
- `kit self-audit --list-rules`: Print the rule list (id, detection-class, severity) without running
- `kit self-audit --only <rule-id,...>`: Run a subset of rules
- `kit self-audit --fail-on-warning`: Treat warnings as failures (errors fail by default; warnings do not)

Error-severity findings (missing CI script, reintroduced `|| true`, unguarded import) exit non-zero. It runs in kit's own CI (the `self-audit` job feeds the security gate), warn-only for the first rollout so only error-severity findings block.

### Built-in git hooks

`kit hooks add <name>` installs a managed hook that calls back into kit. No `.kit.toml` config required.

- `secret-scan` (pre-commit): Block commits that introduce known credential patterns
- `post-pull-audit` (post-merge): Run `verify-pull` after every `git pull` / merge, over `ORIG_HEAD..HEAD` (every commit the pull brought in). It warns on pulled files an agent or editor runs or obeys: `.claude/settings*.json`, MCP configs (`.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`), `.vscode/tasks.json`, dev container config, `.envrc`, agent command/skill/rule dirs, CI workflows, git hook dirs, and `AGENTS.md` / `CLAUDE.md` / `GEMINI.md` anywhere. `git pull --rebase` fires no `post-merge`, so a rebase pull is not audited
- `context-check` (pre-push): Block a push when the live CLI context does not match `.kit.toml [context]` (see Context lock)
- `worktree-gates` (post-checkout): When git creates a worktree, install the PreToolUse gates there, and kit's Claude Code deny rules and sandbox block, if the main checkout has them. `kit agent-config` installs it by default

### Environments + elevation

Production credentials are gated behind explicit env-switching and short-lived elevation.

- `kit env switch <dev|staging|prod>`: Toggle the active environment marker
- `kit env current`: Show active env (color-coded), `kit env list` for available
- `kit auth elevate [--scope <op>] [--ttl-minutes N]`: Mint a TTL'd elevation marker (TOTP or yes-prompt). Required before any destructive secret op. `--list-scopes` (also `--json`) prints every scope, what it unlocks, and whether it is one-shot — without elevating anything.
- `kit auth setup-totp`: One-time TOTP enrollment (writes `~/.kit/totp-secret` 0600)
- `kit auth status`: Show active elevation
- `kit auth revoke`: Drop the elevation marker early
- `kit audit secrets --key <NAME> --since <ISO> [--json]`: Was NAME read or written through kit since then, and by whom, answered from a verified chain (exit 1 when the chain or anchor does not verify). The answer states its coverage: reads through kit only; processes that read `.env.local` directly are not visible
- `kit audit secrets [--since-days N] [--key <name>] [--target <name>]`: Forensics: who touched which key, when. Reads are recorded as `secrets.read` with `[governance]` on or off (names, store, kit surface and agent harness, never values); reads that bypass kit, such as a process opening `.env.local`, are not visible. With `--target <platform>`, the keys kit recorded writing there (propagate, sync, rotate, migrate, onecli), plus the names `[deploy.<platform>]` declares without a recorded write, as a rotation list after a provider breach
- `kit audit verify [--strict]`: Verify the keyless hash chain + the external HMAC anchor (a tip mismatch is a keyless prefix rewrite, a count mismatch is truncation/rollback). `--strict` (or `[governance.audit].require_anchor`, or once the machine has anchored any log) turns an unanchored log / unreadable key / unsealed tail into a hard failure, so a project-writable `log_file` cannot repoint verification at a forged, never-anchored file and pass
- `kit audit anchor`: Seal the current log with the machine-local anchor key (`~/.kit/audit-anchor.key`, `0600`) so a later keyless rewrite or truncation is detectable. The append path stays keyless (a sandboxed agent with no key keeps logging); the key is only needed to seal/verify. Key rotation reports as a distinct `anchor-key-changed` status, not a false tamper alarm. Honest scope: this is not tamper-proof against a same-UID principal who can read the key
- `kit check --attest` / `kit ci --attest` / `KIT_ATTEST=1`: opt-in, fail-soft (never blocks or alters the verdict). Writes `.kit-check-attestation.json` recording which scanners actually ran plus the verdict, signed with the machine-local anchor key (authoritative; the verifier needs that key). An Ed25519 receipt is a portable fallback whose embedded public key is **untrusted**: `kit check verify-attestation <file>` reports `unverified-authenticity` (not green) unless the key is pinned (TOFU in `~/.kit`, refuses silent overwrite) or passed via `--key`

### Context lock

When you work across several accounts and projects (gcloud, Vercel, GitHub, npm) it is easy to be in the wrong one without noticing, and a logged-in account plus a selected project are not assumed to belong together. Declare the exact pair per repo and kit verifies the live tools against it:

```toml
[context]
gcloud = { account = "ops@acme.com", project = "acme-prod", config = "acme", region = "europe-west4" }
vercel = { team = "team_…", project = "prj_…" }   # the ids in .vercel/project.json
github = { org = "acme", remote = "github.com/acme/app" }
git    = { email = "you@acme.com" }
npm    = { registry = "https://registry.npmjs.org" }
```

- `kit context check`: verify the live account+project of each CLI matches the declaration. A right account with the wrong project is a mismatch, not a pass. Read-only; exits non-zero so it can gate.
- `kit context use`: activate the declared context (gcloud config + repo git identity). Touches only local config, never an account or a deploy.
- `kit context --prompt`: a fast, read-only indicator (e.g. `[gcp:acme-prod]`) for your shell prompt, so the context you are in is always visible.
- `kit hooks add context-check`: install a pre-push hook so a push to the wrong org/project is blocked before it leaves the machine.

Context pointers are non-secret and live in config; the credentials they authenticate with stay in the vault.

### Quality gates (baseline-aware)

- `kit check --enforce-tests`: Fail when net-new source files lack a sibling `.test.ts`
- `kit design`: Static a11y scan (img-alt, button-empty, anchor-no-href, input-no-label) + design-token consistency (raw `#hex` / `px` bypass). `--enforce` to gate, `--json` for machine output
- `kit monkey-test`: Role-based release gate for money-handling apps: stack/env/seed detection, Playwright desktop+mobile crawl, sandbox money flow, and security pack. See [docs/MONKEY_TEST.md](MONKEY_TEST.md)
- `kit review`: Meta-runner: `check` + `design` + `standards` + `adr` in one command. Use as a single PR-gate entry point for AI agents
- `kit adr {check,list,freeze}`: Enforce accepted ADRs' machine-readable `kit-enforce` rules over the repo, cited back to the ADR ("why is this blocked? → ADR-0007"). Rule types: `forbid_pattern`, `require_pattern`, and import-aware `forbid_import` (direct + transitive; `follow_packages = true` also walks across npm package boundaries, catching "web must never reach `pg`, even through a wrapper dependency"). Anything the walk cannot follow to the end — an unresolvable import, an unreadable module, a depth/node bound — is surfaced as a `gap`, never a silent pass. So is a rule that cannot check anything: an invalid regex or glob, or a `paths` glob that selects no file `adr check` reads (it reads code files only, so a rule over `docs/**/*.md` is a gap). Only `accepted` ADRs gate; prose is never interpreted (zero-LLM). `freeze` baselines existing findings so only NEW ones fail, and records which ADRs were enforced: an enforced ADR that is later demoted, deleted or stripped of its rules is a gap until it is restored or a new freeze accepts the lower floor
- `kit baseline freeze`: Snapshot current findings (untested files, a11y, tokens, standards, ADR violations/gaps) into `.kit-baseline.json` so pre-existing warnings stay warnings and only net-new findings can fail. Every freeze writes a `baseline-freeze` audit event
- `kit baseline show`: Print current baseline

### Supply chain

- **Bumblebee**: Built-in supply-chain scanner. Verifies every dependency against pinned SHA-256 checksums in `bumblebee.lock.json`. Re-verifies the cache before reuse so a tampered local file is caught (kind `integrity`). Runs in CI on every PR
- `kit triage instructions [path]`: reads the files a coding agent takes as instructions (CLAUDE.md, AGENTS.md, SKILL.md, `.cursor/rules/*.mdc`, Copilot instructions) before the agent does, and reports planted attacks with file, line and rule. Deterministic pattern rules, scoped to instruction files on purpose: README install lines and security docs read like attacks, so README files are left out and the output says so. Measured on 20 attack lines written by a separate model that had not seen the rules, it caught **3 of 20**, with **no false positive** on 20 benign lines written to sit close to the line. It is a floor: a finding is worth reading, and no finding does not mean the files are safe. Rules added after that measure (bulk secrets to a URL, system-prompt requests, hiding activity or findings) were written against 8 of the 20 lines, so 11 of 20 is not a recall figure; a held-out set measures it.
- `kit triage gem <name>[@version]`: a RubyGems release, checked before `gem install`: OSV advisories (a malicious-package `MAL-` record fails, including for a gem the registry has removed), the cooling period from the RubyGems API's per-version publish times, the gem's age and lifetime downloads, and `rubygems_mfa_required`. It reads no gem code, and says that install-time code (a native extension's `extconf.rb`, which runs during `gem install`) is not checked. The bash gate routes `gem install` and `bundle add` through it
- `kit triage cargo <crate>[@version]` and `kit triage go <package>[@version]`: a crates.io release and a Go module release, checked before `cargo install` and `go install`. Both apply the cooling period and the OSV check (a `MAL-` record fails). For a crate kit reads each version's publish time and whether it was yanked, the crate's age, downloads and owners; it reads no crate file, and says that `build.rs` and procedural macros run during `cargo install`. For a Go module kit asks the module proxy for the version and its time (`@latest` is resolved as `go` does, and the module is the longest prefix of the package path the proxy knows); that time is the date of the tagged commit, which the commit's author sets, and the report says the release age rests on it. A probe that could not run prints `NOT CHECKED` with the reason. `KIT_CRATES_REGISTRY` and `KIT_GOPROXY` name mirrors; under air-gap no mirror means no query
- **The install gate covers every install command it can name.** `kit gate-bash` triages npm (`npm`, `pnpm`, `yarn`, `bun`, `npx`), PyPI (`pip`, `pipx`, `uv`), RubyGems (`gem install`, `bundle add`), crates.io (`cargo install`, `cargo binstall`), Go modules (`go install` and `go run` of `pkg@version`) and Homebrew (`brew install`, each formula or cask on its own). An install it cannot reduce to a registry name is refused. `cargo install --path`, `go install .` and `go install ./cmd/x` build what is on disk and pass. `cargo install --git`, `--registry`, `--index`, a formula given as a file or URL, and an environment word that moves the registry (`GOPROXY=`, `CARGO_REGISTRIES_*_INDEX=`, `HOMEBREW_BOTTLE_DOMAIN=`) are refused as unverified sources, with a pointer to `kit triage repo`. Not covered: a registry moved by a config file or by an `export` in an earlier command, and commands that fetch dependencies without naming them (`cargo build`, `cargo add`, `go get`, `go mod download`, `brew upgrade`, `brew bundle`)
- `kit triage pkg <file.pkg>`: checks a macOS installer package before it is opened: SHA-256 against the publisher's checksum list, the signing Team ID against the expected publisher (Node.js Foundation built in, others with `--team-id`), and Apple's notarization. Three separate checks, because a package with a byte added at the end kept its signature and failed only the checksum. A package with no expected publisher never passes. The signature and notarization checks need macOS and are `unverified` elsewhere. It does not install the package.
- `kit triage release <url|file>`: checks a prebuilt release archive or binary before it is extracted, made executable, run or put on PATH: SHA-256 against `--checksum` or the publisher's checksum files next to the asset, a minisign or cosign signature with a key you name (OpenPGP and keyless Sigstore are `unverified`), a GitHub release's age through the cooling period and its repository against `--repo`, and every tar, tar.gz or zip member for absolute paths, `..`, links out of the tree, setuid bits and special entries. It passes only when every `unverified` check is accepted by name (`--accept-unverified`), and a pass for a URL records a `release` receipt in `.kit-triage.jsonl`. It never runs the file.
- `kit triage npm|pip|docker|repo|skill <target>`: Pre-install security evaluation via triage skill
- **npx bin names.** `kit triage npm` checks each bin whose name is not the package's own: the unscoped npm name is `other` (another package, with its maintainers and creation date) or `unclaimed` (anyone can register it). Both print a warning and an `npm-bin` record in `.kit-triage.jsonl`, which the install gate reads to refuse `npx <bin>` without a local install (`docs/INSTALL_GATE.md`)
- `kit triage npm <pkg> --sandbox`: Offline behavioral inspection: `npm pack` → extract → scan for install scripts, eval/base64/network patterns, unexpected scripts, oversized files. No code executes
- **Cooling period.** `kit triage npm`, `kit triage pip`, `kit triage gem`, `kit triage cargo` and `kit triage go` hold back a release younger than `[supply_chain].min_release_age_days` (default 14, 0 is off), so the install gate refuses it and names the newest version that is old enough. For pip the publish time is the earliest upload on PyPI (or the `KIT_PYPI_INDEX` mirror). `kit triage pip name@1.2.3` is read as `name==1.2.3`, and the output says so. A security patch is waived when OSV says the release is the first one that fixes an advisory for the version in use: the one your lockfile pins (`package-lock.json`, `bun.lock`, `pnpm-lock.yaml`, `yarn.lock` or `Gemfile.lock`), else the one installed — npm's global install (found from `npm_config_prefix`, the user `.npmrc` or the prefix of the running `node`, without running npm), then `node_modules/<pkg>`; for pip the `.dist-info` in `python3`'s site-packages; for gems the gemspecs under `GEM_HOME`/`GEM_PATH`. An installed version counts only when the registry has published it, and it never skips the cooling period the way a lockfile pin does. The cooling line says where the version came from, or which sources it checked. A release whose publish time cannot be read (registry unreachable, or air-gap with no mirror named) is held back too. `min_release_age_enforce` defaults to true; `min_release_age_enforce = false` in `.kit.toml`, or `KIT_COOLING_ENFORCE=0` for one run, turns the hold into a warning. With enforcement on, the hold prints as `x CRITICAL: cooling: …` and counts in `Critical issues` for every ecosystem (npm, pip, gem, cargo, go); the verdict is still `TRIAGE HELD: cooling period` unless another critical fails the triage
- `kit check` row `runtime installs: node`: lists the Node installs of mise, Homebrew, nvm, fnm, Volta and `/usr/local`, names the one PATH runs, judges each with the release data of the runtime row and proposes (never runs) removing unused installs that are end of life or lack a security release
- `kit scan`: Run the installed external scanners (Snyk, Trivy, Grype, Semgrep, osv-scanner, Socket) and merge them into one local, air-gap-aware verdict. **GuardDog** (opt-in via `KIT_GUARDDOG=1` or `[scan] guarddog`) adds local malware detection. The **cloud** scanners (Snyk, Socket) run when their token is set (`SNYK_TOKEN` / `SOCKET_SECURITY_API_TOKEN`, resolved from `[scan.tooling]` vault or env — kit never stores them) and are **dropped in air-gap** mode; `kit setup` asks the network posture (connected vs enclave) and writes `[air_gap]`. Kit retains reported Socket policy violations and marks Socket coverage as partial. Token absent → the scanner is skipped, not failed
- **Scanner-health gate.** The exit verdict accounts for scanner _health_, not just findings: a scanner that errored, isn't installed, or lacked its token can no longer exit 0 (a false green). Default is a loud warn (no existing green CI breaks); opt in to a hard fail via `[governance.scan].required_scanners` (a listed scanner that didn't run fails) or `kit ci --strict` / `KIT_CI_STRICT=1` (any non-running scanner fails)
- `kit scan` reports uncovered project paths, requested images, and Maven SBOM inputs in text, JSON, and SARIF.
  Strict mode fails when the scope is incomplete. A required scanner must complete all its scheduled runs.
  `kit scan --update-baseline` requires complete coverage of the selected scan. It preserves the prior baseline when coverage is incomplete.
- `kit airgap verify`: assert every scanner that would run in air-gap mode resolves to a local artifact (no cloud-only scanner, no registry config) and print a pass/fail table. In air-gap mode a registry (`p/…`) `KIT_SEMGREP_CONFIG` is refused in both scan paths (it would egress to the semgrep registry), while a **local** ruleset path is kept so semgrep can still run fully offline
- Supply-chain findings auto-append to `.kit-findings.jsonl` (one JSON line per finding). They stay separate from the hash-chained `.kit-audit.jsonl`, whose integrity would be broken by raw finding rows
- Releases ship with SLSA provenance (`npm publish --provenance`), CycloneDX + SPDX SBOMs on every GitHub release, cosign-signed Docker images, and weekly OpenSSF Scorecard From 7.2.1 the publish job scans the installed package and fails when an SBOM lists fewer than 10 dependencies.

### Shell guard (observe mode)

The agent loop is gated (the PreToolUse install-gate across 11 harnesses), but a
human typing `npm i x` / `npx y` / `brew install z` in their own terminal reaches
the machine ungated. `kit guard install` writes PATH shims for the install +
fetch-and-run family (`npm npx pnpm yarn bun bunx pip pip3 pipx uv uvx brew gem
cargo git`) that run the **same hardened parser + triage verdict** the agent gate
uses — and log what it WOULD decide to `~/.kit/guard-observe.jsonl`.

v1 is **observe-only** by the exec-broker discipline (observe → evidence →
enforce): a shim never blocks and never breaks the tool — kit missing or
crashing means unchanged behavior, non-install subcommands pass silently, and
`KIT_GUARD_BYPASS=1` skips observation for one call. `kit guard status` shows
what has passed through, what enforce mode would have stopped, and whether a
fresh login shell actually resolves each guarded tool to kit's shim (so a later
PATH prepend cannot silently displace it); `kit guard uninstall` removes
everything. `git clone` is **observe-only**, not hard-gated: the shim records
repo intake and points at `kit triage repo <url>` for third-party dependencies.
Notable: the shims also see the `npx`-spawned
MCP servers agent harnesses launch **outside** any Bash gate — coverage the
PreToolUse hook can't reach.

A shim hands the call to the next match on `PATH`, so another shim manager
(mise, asdf, pyenv, rbenv) still chooses which version runs — but kit drops its
own directory from `PATH` before handing off into one, because those managers
re-resolve the tool through `PATH` and would otherwise land back in kit's shim
forever ([#461](https://github.com/sandstream/kit/issues/461)). Shims also
self-heal: `kit guard-observe` rewrites the shim that called it when the file
predates the running kit version, so an upgrade doesn't leave old wrappers
behind, and `kit guard status` names any that are still stale.

### Compliance evidence

`kit coverage` emits deterministic _evidence maps_: it maps kit's own checks and self-audit rules to a vendored, pinned, curated subset of a standard's controls and buckets each as auto-verified, gap, manual, or n-a. `--json` (or `--format=json`) emits the structured report for a GRC tool to consume.

Eight standards are registered (`--list-standards`; `--standard=<key>`, or `all`): OWASP **ASVS 4.0.3 L2** (default) · **LLM Top 10** · **Agentic Top 10** · **MCP Top 10** · NIST **SSDF 800-218A** · **NIST 800-53 Rev. 5** · **AIUC-1** · **GCP WAF Security**. Toggle the set with `[coverage].standards` in `.kit.toml` (absent ⇒ all on).

The NIST 800-53 map is deliberately at the **control-family** level (20 families, not ~1000 controls): a family bucketed `auto` means kit emits deterministic evidence relevant to it — never that every control in it is satisfied. Physical, personnel, and organizational families (PE/PS/AT/CP/MA/MP) are `n-a` by charter rather than quietly claimed.

It is explicitly **an evidence map, not a compliance attestation**: it never claims "compliant". The goal is to be the deterministic evidence source a GRC tool ingests, not a worse version of one. (`experimental` tier.)

### Stability & contracts

As of 2.0, kit's public surfaces are versioned contracts, not just code that happens to work today.

- **Command stability tiers.** Every command carries a `stable | experimental | deprecated` tier. `stable` commands will not be removed, renamed, or have their exit-code / `--json` semantics broken across 2.x (additive-only in minor releases). All shipped commands are `stable` except `team` (`experimental`); `deprecated` commands print a stderr warning every run. A committed `contracts/public-surface.json` golden snapshot plus a drift test enforce this: a surface change fails CI until it is reviewed, regenerated, and labeled `BREAKING`. See [docs/CLI_STABILITY.md](CLI_STABILITY.md).
- **Versioned `.kit.toml`.** The config carries a top-level `version` (`CONFIG_SCHEMA_VERSION = 1`; an absent field is treated as legacy v0). `kit config migrate` runs an ordered, fixture-tested migration from the detected version to the current one: `--dry-run` (the default, which prints the plan and a value-level diff and writes nothing), a real run writes `.kit.toml.backup` first (refuses to clobber an existing backup without `--force`) then re-parses and validates the result and restores the original on any failure, and `--check` exits non-zero on a stale config for CI. **Upgrade note:** run `kit config migrate` once; v1 is the baseline (a no-op version stamp), so nothing breaks today, but the migration path is now in place for any future schema change.
- **`adapter-sdk@1.0`** is frozen on its own semver track, decoupled from kit's version, with a documented public surface, a kit-compatibility matrix, and caret-pin guidance (see [docs/API_STABILITY_AND_VERSIONING.md](API_STABILITY_AND_VERSIONING.md)).

## Service Provisioning

kit can automatically provision and configure services for your project, designed for agent-native workflows (no browser required):

```bash
kit add stripe/payments    # Set up Stripe with API keys
kit add supabase/db        # Initialize Supabase project
kit add vercel/hosting     # Link repository to Vercel
```

### How it works

1. Checks if the service CLI is installed and authenticated
2. Provisions resources via CLI/API (no browser needed)
3. Extracts credentials and configuration
4. Writes secrets to `.env.local`
5. Records provisioning metadata in `skills-lock.json`

### Available Services

- **stripe/payments**: Payment processing with Stripe
  - Requires: `stripe` CLI ([install](https://stripe.com/docs/stripe-cli))
  - Provisions: API keys, creates test mode configuration
  - Secrets: `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`
  - Example:
    ```bash
    brew install stripe/stripe-cli/stripe
    stripe login
    kit add stripe/payments
    ```

- **supabase/db**: Database and authentication with Supabase
  - Requires: `supabase` CLI ([install](https://supabase.com/docs/guides/cli))
  - Provisions: Local dev instance or links existing project
  - Secrets: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
  - Example:
    ```bash
    brew install supabase/tap/supabase
    supabase login
    kit add supabase/db
    ```

- **vercel/hosting**: Hosting and deployment with Vercel
  - Requires: `vercel` CLI ([install](https://vercel.com/docs/cli))
  - Provisions: Links repository, sets up deployment
  - Secrets: `VERCEL_PROJECT_ID`, `VERCEL_ORG_ID`
  - Example:
    ```bash
    npm i -g vercel
    vercel login
    kit add vercel/hosting
    ```

- **expo/eas**: Mobile app builds with Expo EAS
  - Requires: `eas` CLI ([install](https://docs.expo.dev/eas/))
  - Provisions: EAS project, build configuration
  - Secrets: `EXPO_TOKEN`, EAS credentials
  - Example:
    ```bash
    npm i -g eas-cli
    eas login
    kit add expo/eas
    ```

- **searxng/instance**: Privacy-respecting search engine
  - Requires: `docker` and `docker-compose`
  - Provisions: Local SearXNG instance
  - Secrets: `SEARXNG_URL`, `SEARXNG_SECRET`
  - Example:
    ```bash
    kit add searxng/instance
    ```

The full adapter set (each provisions/reuses the relevant keys; run `kit add <id>`):

| Service               | Purpose                                               |
| --------------------- | ----------------------------------------------------- |
| `stripe/payments`     | Stripe payment processing (products + price IDs)      |
| `supabase/db`         | Supabase database + authentication                    |
| `vercel/hosting`      | Vercel hosting + deployment                           |
| `flyio/hosting`       | Fly.io container deployment                           |
| `railway/hosting`     | Railway (Heroku-style) deployment                     |
| `neon/db`             | Neon serverless Postgres                              |
| `planetscale/db`      | PlanetScale serverless MySQL                          |
| `upstash/redis`       | Upstash serverless Redis                              |
| `cloudflare/r2`       | Cloudflare R2 object storage (S3-compatible)          |
| `clerk/auth`          | Clerk authentication + user management                |
| `resend/email`        | Resend transactional email                            |
| `loops/email`         | Loops marketing + transactional email                 |
| `sentry/monitoring`   | Sentry error tracking + performance monitoring        |
| `posthog/analytics`   | PostHog product analytics + session recording         |
| `tinybird/analytics`  | Tinybird real-time analytics on ClickHouse            |
| `liveblocks/realtime` | Liveblocks collaborative realtime (presence, cursors) |
| `trigger/background`  | Trigger.dev background jobs                           |
| `inngest/background`  | Inngest event-driven background jobs                  |
| `flagsmith/flags`     | Flagsmith feature flags + remote config               |
| `expo/eas`            | Expo Application Services (mobile builds)             |
| `searxng/instance`    | Self-hosted SearXNG search engine                     |

Add your own with `kit create-plugin <name>` (see [docs/PLUGIN_DEVELOPMENT.md](PLUGIN_DEVELOPMENT.md)).

### Example Workflows

**New project setup:**

```bash
# Clone project
git clone https://github.com/user/my-app
cd my-app

# Check what's needed
kit check

# Provision all services at once
kit add stripe/payments
kit add supabase/db
kit add vercel/hosting

# Verify everything is configured
kit check
```

**Agent-driven provisioning:**

```bash
# Agent provisions services automatically
kit add stripe/payments
# → Checks if stripe CLI installed
# → Verifies authentication
# → Creates API keys
# → Writes to .env.local
# → Updates skills-lock.json

# Check what was provisioned
cat .env.local | grep STRIPE
cat skills-lock.json | jq '.provisioned["stripe/payments"]'
```

**Creating custom adapters:**

See [docs/CUSTOM_ADAPTERS.md](CUSTOM_ADAPTERS.md) for a complete guide on creating custom service adapters.

**Troubleshooting:**

Common issues and solutions:

- **"Required tool not installed"**: Install the service's CLI tool (see examples above)
- **"Not authenticated"**: Run the service's login command (e.g., `stripe login`)
- **"Provisioning failed"**: Check CLI is in your PATH: `which stripe`
- For more help, see [docs/CUSTOM_ADAPTERS.md](CUSTOM_ADAPTERS.md#troubleshooting)
