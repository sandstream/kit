# Tool evidence in memory

Memory stores tool requests and reported responses separately. A request does not prove that the tool ran.
A response does not prove success or an external effect.

## Supported capture

Claude Code capture joins `tool_use.id` with `tool_result.tool_use_id` inside the same session.
Codex capture joins native function and custom calls with their corresponding output records.
Codex tool parents use separate identifiers. Existing conversation identifiers stay unchanged.

| Outcome | Meaning |
| --- | --- |
| `unknown` | No supported response evidence is available. |
| `returned` | A corresponding response was recorded. Its output can be opaque text. |
| `error` | The native response contains an explicit error flag. This does not establish a gate denial. |
| `denied` | Structured evidence identifies a gate denial. Error text alone is insufficient. |
| `conflict` | The retained evidence contains incompatible outcomes. |

Import preserves these distinctions. A later response can update an existing call.
Unknown evidence cannot erase a known outcome. Conflicting outcomes remain visible.
Identified calls cannot change their parent, tool name, or input during import.
Repeated imports do not duplicate identified calls.

## Coverage and limits

Schema 18 adds a capture version and expected call count to each message. It also records the parser version for indexed files.
Import checks the expected count. This distinguishes messages with zero calls from snapshots with missing tool rows.
An explicit writable open migrates an older supported store. A read-only open does not migrate it.
Legacy calls start with unknown outcomes. Existing messages start with incomplete capture.

The next index operation revisits unchanged Claude and Codex files from the older parser.
It can recover identifiers and responses only when those records remain in the source transcript.
An unreadable file remains eligible for a later index attempt.

Malformed records, unsupported tool events, and unmatched responses leave capture incomplete.
Known opaque dispatch wrappers also leave capture incomplete. Their nested calls are not inferred from code text.
Other harness parsers retain incomplete capture until they support this evidence contract.

Coverage applies to retained, indexed messages. It does not certify missing transcripts, unrecorded child sessions, or external activity.
Tool response bodies are not added to searchable conversation text by this feature.

## Reports

`kit insight unused` preserves positive references when capture is incomplete.
Missing references remain unknown without sufficient capture evidence.
Complete native capture does not establish complete skill use. A skill can be read without an explicit `Skill` request.

`kit skill test <path> --runtime --gate` requires complete evidence for its required runtime checks.
Unknown outcomes and incomplete capture do not produce a successful gate.
Recorded results describe reported behavior. They do not certify external effects or output quality.

## Forget

Forget removes the message and its linked tool requests.
The tombstone prevents a later index or import from restoring those requests.
The migration also removes tool rows linked to existing tombstones.
Raw transcript files remain separate sources. Kit does not delete them through memory forget.
