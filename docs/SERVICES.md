# Local services

Agent sessions start local services: a Supabase stack, a compose project, a test container, a dev
server. The session ends, and the service keeps running. After a few weeks nobody knows who owns
it or if it is still needed. `kit services` keeps a local index of who runs what, and checks that
index against what actually runs.

The index is one file per user: `~/.kit/services.json` (set `KIT_SERVICES_FILE` to move it).
Nothing leaves the machine.

## The rule for agents

1. **Register what you start.** Right after you start a service, register it:

   ```sh
   kit services add app-db --kind supabase --ref my-project --purpose "e2e tests for #42"
   ```

   You get a lease of 4 hours. Use `--ttl 30m`, `--ttl 8h` or `--ttl 2d` for a different length.

2. **Renew while you need it.** `kit services renew app-db` gives a new lease. Kit tells you on
   your next prompt when a lease ends within 30 minutes.

3. **Stop it when you are done.** `kit services stop app-db` stops the service, checks that it is
   gone, and removes the entry.

## Kinds

| Kind        | `--ref`                   | Running when                                             | `stop` does                                                   |
| ----------- | ------------------------- | -------------------------------------------------------- | ------------------------------------------------------------- |
| `supabase`  | the Supabase `project_id` | a container has label `com.supabase.cli.project=<ref>`   | `supabase stop --project-id <ref>` (keeps the volumes)        |
| `compose`   | the compose project name  | a container has label `com.docker.compose.project=<ref>` | `docker compose -p <ref> down`                                |
| `container` | the container name        | a running container has that name                        | `docker rm -f <ref>`                                          |
| `pid`       | the process id            | the process exists                                       | SIGTERM, then SIGKILL after 5 s (`taskkill /T /F` on Windows) |
| `port`      | a TCP port on localhost   | the port accepts a connection                            | not supported: kit cannot tell which process holds it         |

When docker is not installed or not running, docker-backed entries show `unknown`. Kit never
reads `unknown` as `dead`, so `prune` keeps those entries.

## Who owns an entry

`add` records the caller as the owner:

- In Claude Code, the session id from `CLAUDE_CODE_SESSION_ID`.
- In Codex, the thread id from `CODEX_THREAD_ID` (or `CODEX_SESSION_ID`).
- Otherwise `unknown`. Add `--owner <label>` to name yourself. In a plain terminal, an entry
  without a session and without a label is owned by any other terminal without a label.

A different session of the same agent is not the owner.

## Handle a service someone else left

1. **Look.** `kit services ls` shows every entry with its status:

   - `running`: the lease is active and the service runs.
   - `expired`: the service runs, but the lease has ended.
   - `dead`: the service no longer runs. `kit services prune` removes these entries.
   - `unknown`: kit cannot check it (for example, docker is not running).

   Below the table, kit lists running docker workloads that nobody registered, grouped by
   Supabase project or compose project, with their age and memory use. These have an unknown
   owner. To take one over, register it with `add`.

   `(session ended)` after an owner means that the owning session has ended. That session
   cannot answer a request until someone resumes it.

2. **Ask.** If the lease is active, `stop` refuses and prints the owner. Ask the owner instead:

   ```sh
   kit services ask app-db --message "swap is full, can I stop this?"
   ```

   The owner sees the request on its next prompt and answers with one of these:

   - `kit services keep app-db`: still needed. Renews the lease and clears the request.
   - `kit services release app-db`: stops the service now.

3. **Wait for the lease.** If the owner does not answer, the lease ends. Then anyone may stop it:

   ```sh
   kit services stop app-db
   ```

4. **Force only when you must.** `--force` stops a service with an active lease. Use it only when
   you know the owner does not need the service.

A `pid` entry is a special case. The operating system reuses process ids, so a non-owner must
always pass `--force` for a `pid` entry, also after the lease has ended. Check the process first.

## Hooks

If you installed kit's memory hooks (`kit memory install`), the same hooks also do this:

- **Every prompt (Claude Code):** one line when a service this session owns has a stop request,
  or its lease ends within 30 minutes.
- **Session start (Claude Code and Codex):** the same line, plus a line about entries for this
  project whose owning session has ended.
- **Session end (Claude Code and Codex):** kit marks the entries the session still owns as
  `session ended`. A hook's output at session end reaches nobody, so kit records the fact
  instead of printing it. The next session and `kit services ls` show it.

Codex shows every prompt-hook output in its conversation view, so kit does not install a Codex
prompt hook. Codex sessions see their notices at session start.

The hooks read only the registry file. They never call docker, so they do not slow a prompt.
