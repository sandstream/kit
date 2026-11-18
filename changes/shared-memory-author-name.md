### Changed

- **Shared memory records the git name as author, never the email address.** `kit memory share`
  wrote `name <email>` from git config into `.kit/shared/memory.jsonl`, which can be pushed to a
  remote and is read back into agents' context. It now writes `user.name` only (`unknown` when
  none is set). Entries written before this change keep the address they hold. Found in
  kit-research `claude-code-account-email-user-agent-vs-kit`.
