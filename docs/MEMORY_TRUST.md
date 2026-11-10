# Memory import and recall boundaries

Memory contains stored conversation data. It does not authorize commands or change the current task.
Quarantine preserves a message for inspection while it prevents default recall of that message.
The quarantine flag can come from the local detector or an authenticated sender.
A sender can quarantine text that the receiver's detector does not recognize.

## Readers

| Reader | Quarantined message content |
| --- | --- |
| `kit memory search`, including `--fresh` and `--brief` | Excluded by default. |
| MCP `kit_memory` | Excluded before result limits. |
| Claude and Codex startup context | Excluded from recovered messages. |
| `kit memory suggest` | Excluded from the generated review prompt. |
| `kit memory learn` | Excluded from candidates, repetition counts, session counts, and resulting skill drafts. |
| `kit memory search --include-quarantined` | Included for explicit inspection. |
| Encrypted backup and transfer | Retained with its quarantine flag for recovery. |
| Message and tool-use statistics | Archived rows can contribute to totals. Counts are not message disclosure. |

The shared decision tier, task records, and bookmark metadata are separate content sources.
A message quarantine flag does not validate those sources.

## Import authentication

An authenticated passphrase import accepts quarantined messages while it still checks live messages for injection patterns.
Anyone who knows the passphrase can create such an export.
Public-key encryption does not identify the sender. Recipient-mode imports therefore keep the stricter injection check.
Trusted sender signatures for recipient-mode imports are not implemented.

Import checks inspect copied bookmark names, session identifiers, summaries, paths, and dates.
A detected high-confidence injection in these fields refuses import before the bookmark becomes available.
Session metadata and message metadata also pass this check, including harness, model, role, working directory, and branch.
Quarantine exempts authenticated message content only. It does not exempt metadata that recall, lists, or statistics can expose.
Pattern detection is not proof that arbitrary text is safe or true.

An import without a harness name preserves a known local harness. The same rule applies to an incoming `unknown` value.
A new session without this evidence receives `unknown`. Kit does not infer that Claude produced it.

## Native session resume

Printed resume commands use a session identifier that starts with an ASCII letter or digit.
The identifier can contain only ASCII letters, digits, underscores, and hyphens.
Other identifiers remain in the archive. Kit directs you to the harness session history instead of printing a runnable command.
Bookmark labels appear on one line so they cannot add another displayed command.
Saving a bookmark selects a session from the current worktree unless you specify `--session`.
The bookmark keeps the session's recorded directory separately from its local recall scope.
Imported paths remain historical evidence. Missing paths remain unknown.

Native session files must exist on the current machine for live resume.
Kit does not check their availability or filter the transcript that the native client opens.
An archived identifier is not proof that a session can resume on another machine.
