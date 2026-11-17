### Added

- **`kit check` now reports the `kit gha-audit` workflow findings in its security category.** A
  workflow that `kit gha-audit` warned on (an unpinned action, a pwn request, a skippable gate)
  showed nothing in `kit check --category security`. The rows come from the same local scan of
  `.github/workflows/*`; it makes no network call and took about 35 ms on kit's own workflows. The
  branch-protection half of `kit gha-audit` needs the GitHub API and stays out of `kit check`.
