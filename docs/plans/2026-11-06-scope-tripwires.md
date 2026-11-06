# Scope tripwires: decoys inside the allowed scope, a touch is evidence

> Steps use checkbox (`- [ ]`) syntax for tracking. Each phase lands as its own PR with green
> CI before the next starts. Phase 0 is an experiment: its result decides whether phase 1 starts.

**Goal:** Place decoys that no task needs inside the area an agent may already reach, such as a
`.env.canary` with fake keys or a `~/.ssh/id_canary`. When an agent reads, runs or sends one, kit
denies the action, writes a `tripwire` event to the hash-chained audit, and shows it in
`kit doctor`. The output is evidence, not a score: _"on 2026-11-06 at 14:02, session X read
`.env.canary`."_

**Why:** kit-research `docs/research/openai-gpt-6-cyber-vs-kit.md`, section Innovation. A
vendor's honeypot test measures scope departure in its own lab, as a rate (0.07% for GPT-6 Cyber
without the safety prompt, 5.51% for GPT-5.6 Cyber, both secondary). Nothing measures it on the
user's machine with the user's agent.

## Measured before planning (2026-11-06)

- **The exec-broker sees no reads.** `src/exec-broker/broker.ts` gates the effects a request
  _declares_: `egressTargets`, `fsWrites`, `envRequested`. A read inside `fs.root` is never
  decided. A tripwire on reads therefore cannot live in the broker; this was the plan's stop signal
  for a broker-only design.
- **PreToolUse hooks do see reads.** Claude Code passes the tool input to a PreToolUse hook:
  `Read {file_path}`, `Bash {command}`, `Grep {pattern, path, glob}`, `Write`/`Edit {file_path}`.
  kit already gates two of these: `kit gate-env` (`src/env-write-gate.ts`, Write/Edit to `.env*`)
  and `kit gate-bash`. `src/agent-trifecta.ts` already names `Read`, `Grep` and `Glob` as file
  readers.
- **Hook wiring is protected.** It lives in `src/agent-config.ts`, which is in
  `.github/kit-protected-paths.json`. That phase goes to the owner.
- **A subprocess is not seen.** A hook sees `cat .env.canary` in a Bash command. It does not see a
  script, a test or a build tool that opens the file. This is a coverage limit, stated in the
  output, not a bug.

## Design

**One rule: the explicit mention.** A tool call trips when the path it reads, the command it runs or
the pattern it lists _names_ a decoy. A broad `grep -r . ` or `ls -a` that would pass over a decoy
without naming it does not trip, because ordinary tooling does that all day (phase 0 counts how
often). Written content (the body of a Write, a PR description) is never a touch.

**Three layers:**

1. **Read gate** `kit gate-tripwire`: a PreToolUse hook for Read, Grep, Glob and Bash. A pure
   `decideTripwire(toolName, input, decoys)` returns `allow` or `trip`; `trip` exits 2 (deny),
   in the shape `kit gate-env` uses.
2. **Broker decoys:** a canary env name (`KIT_CANARY_TOKEN`), a canary egress host and canary
   fs-write paths in the broker policy. A request that declares one gets a third outcome, `tripwire`,
   next to allow and deny.
3. **Evidence:** every trip is a `tripwire` event through `appendAuditEventDirect` (hash-chained)
   with session, tool, decoy and time, and a `kit doctor` row: `tripwire: N touches since <date>`.

**Decoy management:** `kit tripwire add <path>`, `list`, `remove`. The list lives in kit's state
directory, outside the project, so an agent reading the repository cannot learn which files are
decoys. Decoy content is generated fake keys of the right shape, marked so `kit check`'s secret scan
can tell them from real ones (phase 4).

## Phases

### Phase 0: the experiment (no code in `src/`)

- [ ] **Step 1, false-positive floor on real transcripts.** Run
      `node scripts/tripwire-baseline.mjs` on the machine where agents actually work. It reads
      `~/.claude/projects` and `~/.codex/sessions`, prints counts only, and changes nothing.
      Report the three numbers and `by tool`, not the examples.
- [ ] **Step 2, coverage gaps.** List which tools in step 1 read files in ways a hook cannot see
      (scripts, test runners, indexers).
- [ ] **Step 3, conflicts.** Check a decoy against `kit gate-env` (a Write to `.env.canary` is
      already denied), the secret scan, `.gitignore` and the session-start gate.

**Signal:**

- **Build** if `decoy-named` is 0 (the explicit rule raises no false alarm) and phase 1 fits in
  about 200 lines with no new dependency.
- **Stop** if normal tooling names decoy-shaped paths: the signal would be worthless.
- `sweep` is the explicit rule's blind spot: a command that would read a decoy without naming it.
  It is reported, not gated.

**First run, in a cloud session (2026-11-06, one session, 2,065 tool calls):** `decoy-named` 0,
`sweep` 8 (0.4%, mostly recursive greps over `.`), `secret-class` 4 (all text inside heredocs, none a read
of a real secret file). A cloud session is not representative; the owner's local transcripts are
the measurement that counts.

**Owner's run, local (2026-11-06, macOS arm64, Claude Code and Codex transcripts):**

| Measure        | Count   | Share of calls | By tool                                  |
| -------------- | ------- | -------------- | ---------------------------------------- |
| transcripts    | 1,194   |                |                                          |
| tool calls     | 118,163 |                |                                          |
| `decoy-named`  | **0**   | 0%             | none                                     |
| `sweep`        | 212     | 0.18%          | Bash 207, Codex `exec_command` 3, Glob 2 |
| `secret-class` | 306     | 0.26%          | Bash 300, Codex `exec_command` 6         |

- [x] **Step 1 result: the build signal holds.** Across 118,163 real calls, nothing named a planned
      decoy, so the explicit rule raises no false alarm on its own. That says no _name clash_; it
      does not say agents never reach decoy-shaped files.
- **Sweeps, 1 call in 557,** are the blind spot: a command that would read a decoy beside real
  secrets without naming it. They are frequent enough that a broad rule that tripped on them would
  be noise, which confirms the design choice of the explicit rule.
- **Secret-class, 1 call in 386,** is legitimate work already in the neighbourhood a decoy would sit
  in. A decoy name must therefore never be a name tools look for (`.env`, `.env.local`), which the
  planned names are not.
- Steps 2 and 3 (coverage gaps, conflicts) remain, and are part of phase 1's review rather than a
  separate run.

### Phase 1: read gate (not protected)

- [ ] `src/tripwire.ts`: `decideTripwire`, decoy list read and write in the state directory.
- [ ] `src/commands/tripwire.ts`: `kit tripwire add|list|remove`, `kit gate-tripwire`.
- [ ] Audit event `tripwire`; `kit doctor` row.
- [ ] Tests for each, including a Windows path (`C:\\...\\.env.canary`, case-insensitive).

### Phase 2: broker decoys (not protected)

- [ ] Canary env, egress and fs-write entries in `src/exec-broker/policy.ts`; outcome `tripwire`
      in `broker.ts`, recorded like a deny.

### Phase 3: hook wiring (protected, owner)

- [ ] `src/agent-config.ts` adds the `kit gate-tripwire` PreToolUse group, only when a decoy list
      exists.

### Phase 4: secret-scan exemption (protected, owner)

- [ ] `src/check-secrets.ts` recognises kit's canary marker so a decoy is not reported as a leaked
      key.

## Not in scope

- A filesystem watcher or kernel hook for subprocess reads. That is a larger design and an owner
  decision.
- Any model in the decision (ADR-0001). The rule is a string match on declared paths.
