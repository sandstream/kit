# Plan tracking

Kit scans plan files at session start and when you run `kit memory pal list`.
It checks the repository root, `plans/`, `docs/plans/`, `.kit/plans/`, and `.claude/plans/`.
It also checks files beside the repository whose names start with the repository name from `origin`.
Only Markdown files with `plan` in the name count.

Add `Status: DONE` near the top when the whole plan is complete.
Kit also accepts `COMPLETE`, `COMPLETED`, `CLOSED`, `BUILT`, and `SHIPPED`.
The status must be the whole line after `Status:`.
Open checkboxes and pending phase rows keep a plan open despite that status.
A missing status creates a PAL item with an unclear status.
A missing file stays pending until you confirm its status.
Kit skips reconciliation if it cannot read a plan or finds a symbolic link.
Read-only mode lists existing PAL items without a plan sync.
