### Added

- **`kit check` warns when git `user.email` is a real-looking address.** Every commit publishes its
  author address, and agents read `git log`, so the address also lands in model context, where an
  agent can copy it into a request it writes. The new row in `kit check --category security`
  (`git user.email is a no-reply address`) reads the project's effective `user.email` (repo-local
  over global, no network): it passes a GitHub, GitLab, Codeberg or Bitbucket no-reply address or a
  `noreply@` address, warns (low) on anything else, and skips when no address is set. It prints the
  address masked (`a***@example.com`), never in full. Found in kit-research
  `claude-code-account-email-user-agent-vs-kit`.
