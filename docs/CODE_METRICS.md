# Code metrics

Use this command to enforce the general code-quality gate:

```sh
kit standards --category general --enforce --json
```

The general gate measures complexity, function length, duplication and file length.
The default limits are CCN 15, 80 function lines, 5% duplication and 600 file lines.
CCN equals one plus the number of counted decisions.
Set project limits in `[standards.general]`.

Without `--enforce`, new findings and incomplete analysis produce warnings.
With `--enforce`, either condition fails the command.
The JSON field `didNotRun` identifies incomplete evidence, including a tool that started but failed to complete.
The summary field `setupGaps` counts these cases. It does not mean that every tool was absent.
A score excludes incomplete gates. Read the gap count and verdict with the score.

## Tools and source

| Measurement | Tool | Scope |
| --- | --- | --- |
| JavaScript and TypeScript complexity | TypeScript compiler API | Complete source syntax and separate execution bodies. |
| Other supported language complexity | Lizard | Functions reported by that language parser. |
| Duplication | jscpd | Blocks reported by the configured tool version. |
| File length | scc | Files reported by the configured tool version. |

Provision TypeScript as a tool, separately from project runtime dependencies.
The supported compiler versions are 5.9.3 and 6.0.3. New generated tool configurations select 6.0.3.

```toml
[tools]
"npm:typescript" = "6.0.3"
```

Kit resolves the canonical `bin/tsc` executable and its adjacent compiler API.
Unknown versions, unresolved wrappers and unexpected API locations leave analysis unverified.
Kit does not install a compiler during a scan.

JavaScript analysis accepts `.js`, `.jsx`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.mts` and `.cts` files.
Git projects use tracked and unignored source paths. Other projects use a filesystem inventory.
Generated and dependency directories are excluded: `node_modules`, `dist`, `build`, `out`, `.next`, `vendor`, `target`, `.git`, `coverage`, `__pycache__`, `.venv`.
Inputs have a combined 64 MiB limit. Source paths and hashes must match before and after analysis.
Unreadable inputs, invalid UTF-8, syntax errors and unresolved inventory boundaries prevent complete evidence.
Directory links in a Git inventory are refused because Git does not enumerate their target contents.

The parser runs in a child process with a private request file and a restricted environment.
It does not execute project source, resolve project imports or load project configuration.
It performs syntax analysis, not type checking or runtime verification.
Jscpd receives a private empty configuration file. Project jscpd configuration does not define this general gate.

## JavaScript complexity

The metric version is `kit-js-ccn/v1`.
Each execution body starts at CCN 1. These syntax elements add one decision:

- `if`, conditional expressions and loops.
- `catch` and each non-default `case`.
- `&&`, `||`, `??` and their assignment forms.
- Each explicit optional access or call.
- Parameter defaults and destructuring defaults.

Ordinary assignment does not add a decision.
Nested functions, class field initializers and static blocks have separate bodies.
Computed names, decorators, class heritage, enum initializers and namespace execution contribute to the containing evaluation body.
Type-only and ambient declarations contribute no runtime decisions.

Each file has a module body. Its decisions count toward complexity.
Module length does not use the function-length limit. The file-length gate applies separately.
Function length includes the signature and body, measured in physical source lines.

Calibration checks fixed parser examples. It does not establish universal parser correctness.
This JavaScript correction does not prove complete Lizard coverage for other languages.
A successful empty Lizard report alone does not prove that a nonempty project has no executable decisions.
The report reader checks the shape of a worker report: source hash, one module body, body spans, decision offsets and counts.
It does not parse the source again. A worker report that leaves out a function or its decisions passes the reader.
The worker and the reader are parts of the same program. Calibration and the parser tests guard the worker against that defect.

## Reports and baselines

Nonzero tool exits, timeouts, truncated output and malformed reports leave general analysis unverified.
Kit rejects the whole Lizard report when any CSV record is invalid.
It does not convert malformed JSON or invalid numeric fields into zero findings.
When an engine measured a function in at least one file, the project is not empty.
An scc report that lists no file is then incomplete, and so is a jscpd report without a positive source count.
Kit reports file size or duplication as unverified in that case.
When every scanner returns nothing, Kit has no witness and accepts the reports as an empty project.
A scanner that omits some files, but not all, is not detected.

`kit standards freeze` and `kit baseline freeze` refuse incomplete general analysis before baseline publication.
They preserve the existing baseline file on that refusal.
Valid measured findings can still be accepted through an explicit freeze.
This refusal rule does not certify failure handling in every other standards dimension.

JavaScript baseline keys include the metric version and a body anchor: kind, name and the order among bodies of that kind and name in the file.
A change above a function does not change its key. A function with another name does not inherit the key.
A new body with the same kind and name above an accepted one moves the order, and Kit then reports the accepted one as new.
All anonymous functions in a file share one name, so a new anonymous function above an accepted one has that effect.
Older Lizard keys cannot accept new compiler measurements automatically.
Review newly exposed findings. Do not expand a baseline merely to obtain a passing result.

The CLI and MCP `kit_review` standards stage use the same gate.
For a scoped MCP check, set `stages: ["standards"]`, `category: "general"` and `enforce: true`.
That verdict applies only to the selected stage and category.
