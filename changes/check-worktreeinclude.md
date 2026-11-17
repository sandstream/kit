### Added

- **`kit check` warns when `.worktreeinclude` copies `.env` files into agent worktrees.** Claude Code
  and Orca copy every file listed in `.worktreeinclude` into each new worktree, and `.env` is the
  documented typical entry. Each copy lives as long as its worktree, outside the checkout `kit check`
  scans. The new row (warn, medium) names each `.env` or `.env.*` entry; `.env.example`, `.env.sample`
  and `.env.template` are left out as placeholders. It reads only `.worktreeinclude`, never the files
  it names. Found in kit-research `orca-ade-vs-kit`.
