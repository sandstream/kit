### Added

- `kit check` (security) reports whether the daily `kit watch` is still running (row "security watch freshness"). A run older than 48 hours warns with its age and date ("the last kit watch run was 40 days ago (2026-10-14): the daily run has stopped"), and a launchd entry or `kit-watch` workflow that never produced a run warns too. Before, a stopped watch showed only as `sec-prs:stale` in Claude Code's status line, so other harnesses and `kit check` never saw it. A project that never set up the watch gets no row; a cron entry cannot be seen, because kit does not edit crontabs.
