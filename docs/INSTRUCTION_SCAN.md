# Instruction file scan

Run `kit triage instructions [path]` before you read unfamiliar agent instructions.
Use `--json` for structured results. The command does not execute instructions or contact a model.

The scan uses pattern rules. A complete scan without findings does not prove that the instructions are safe.

## Scope

The scanner selects `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `GEMINI.md`, and `SKILL.md`.
It also selects `.cursorrules`, `.windsurfrules`, `copilot-instructions.md`, and `.cursor/rules/*.mdc`.
An explicit file target is read regardless of its name.

The scanner skips `node_modules`, `dist`, `build`, `vendor`, `target`, and `coverage` directories.
It enters these dot-directories: `.claude`, `.cursor`, `.github`, `.codex`, and `.gemini`.
Other dot-directories and directory symlinks are outside the discovery scope.
README files are not selected during directory discovery.

File symlinks are followed. Their targets must be regular files.
Named pipes and other special files are refused. Actual reads have a byte limit, including files that grow during the read.

## Results

Each finding includes a file, line, rule, and sanitized excerpt.
Injection rules also inspect the whole file, so a line break cannot split a recognized phrase past the check.
Custom secret-transfer and download rules retain their documented single-line scope.

`complete` describes coverage within the selected scope. It does not describe whether findings exist.
`unread` lists selected files that were not read.
`coverageGaps` identifies discovery failures, depth limits, entry limits, file limits, and the finding limit.
The command fails if a finding, unread file, or coverage gap exists.
A missing target emits a diagnostic and fails.

The fixed limits are:

| Resource | Limit |
| --- | --- |
| Directory depth | 8 below the target |
| Directory entries | 20,000 across the traversal |
| Selected instruction files | 500 |
| Bytes per file | 1,000,000 |
| Reported findings | 1,000 |

An input exactly at a limit can pass if no data remains unexamined.
If discovery or analysis stops, the result remains incomplete. Narrow the target and run the scan again.
Do not interpret the first part of an incomplete result as a clean scan.

Terminal output and JSON display fields mask known secrets before and after removal of controls and hidden characters.
For fixed provider prefixes, display masking also matches inside surrounding text. Control removal can otherwise hide the token's boundary.
JWT display masking examines each token component once and masks the surrounding token run on a match.
This can mask extra display text. It does not broaden the scan's detection rules.
Internal file identities remain unchanged for filesystem access.
The scan does not lock files or authorize their later execution. A later file change requires another scan.
