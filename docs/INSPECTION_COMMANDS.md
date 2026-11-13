# Identity and external report inspection

## Configured identity

Run `kit whoami` for text output. Add `--json` for structured output.
The command accepts no positional arguments.

The identity comes from `[governance.agent]`. It does not authenticate a person or a model session.
An absent identity produces `agent: null`. A missing configuration file is valid.
An invalid or unreadable configuration produces exit 1 and an error, without a fabricated identity.

The report distinguishes two environment decisions:

| Field                | Meaning                                                                               |
| -------------------- | ------------------------------------------------------------------------------------- |
| `config_environment` | The configuration overlay selected by `--env`, `KIT_ENV`, `NODE_ENV`, or the default. |
| `environment`        | The access environment used by governance.                                            |
| `environment_source` | `config`, `env`, `git`, or `default`, according to the governance decision.           |

An explicit `[governance].environment` overrides runtime and branch detection for access.
The report uses the same decision as the operation gate.
Changing the configuration overlay does not itself select an access environment.

Enabled governance reports both stored usage and effective limits, including default limits.
Token limits must be finite and nonnegative. Fractional token limits are allowed.
Operation limits must be nonnegative safe integers, at most `9007199254740991`.
Omitted limits use the defaults. An invalid limit must not disable the budget gate.
The defaults are 1,000,000 tokens per day and 100 operations per hour.
An explicit zero is a zero allowance. It does not disable a limit.
Invalid budget state produces an error. It must not become zero usage.
Inspection does not increment or persist budget counters.

Governed operations charge their allowance before execution. Concurrent CLI and MCP calls share the ledger in the requested directory.
A normal return keeps the charge, including a reported failure. A thrown operation refunds its own charge when storage permits.
A refund cannot subtract usage from a later period or a replacement ledger.
Token estimates use JavaScript number precision. Refunds remove negative and near-zero rounding residue.
A process crash keeps the charge until the normal period reset. It does not grant unused allowance automatically.
An admission storage error stops execution. A refund storage error records the failed operation and the refund failure.
The audit metadata uses `phase: "budget-refund-failed"` and retains the original operation error.

Read-only mode retains its non-writing accounting behavior. Inspection and advisory budget checks do not reserve capacity.
The ledger counts operations and supplied token estimates. It does not measure money transfers or provider invoices.

The local `.kit-budget-lock.sqlite` file coordinates short ledger updates through SQLite.
Do not delete or replace it while Kit processes run. Process exit releases its lock without manual cleanup.
Keep it and `.kit-budget.json` out of version control.
A failed JSON replacement preserves the previous complete ledger. File data is synced before replacement.
Power-loss durability and network filesystems require separate validation.
Use trusted parent directories and one lock-module instance per process. Separate worker-thread instances are unsupported.
All concurrent writers must use this protocol. Older Kit versions and direct file edits do not honor the lock.

Displayed identity fields mask recognized credentials and remove terminal control sequences.
The configuration remains unchanged.

## Governance inspection

Run `kit governance` or its documented alias, `kit governance status`.
No other positional arguments or command-specific flags are accepted.
The report uses the effective configuration and the same access environment decision as the operation gate.
It shows read-only mode, budget enforcement, stored usage, and configured agent fields.
It does not reserve budget or update the revocation cache.

Enabled revocation performs a fresh GET with a five-second limit. The response must contain a boolean `revoked` field.
A revoked agent or an unverified response produces exit 1. Disabled revocation performs no request.
This fresh report does not certify every operation or provider connection. Operation gates can also apply cached revocation policy.
The operation cache distinguishes project, endpoint, and agent ID. A failed forced refresh invalidates its earlier permission.
See [governance](../GOVERNANCE.md#6-access-revocation) for cache intervals and containment limits.
Invalid configuration or unreadable budget state produces exit 1 before the report starts.
Unknown configuration fields remain accepted, but warning output masks recognized credentials and removes terminal controls.

## Temporary project approval

Run `kit auth elevate` from an interactive terminal. The default scope is `all` and the default duration is 15 minutes.
Use `--scope <scope>` for a narrower scope. Use `--ttl-minutes <N>` for an integer duration from 1 through 240 minutes.
Explicit invalid environment or flag durations are refused. They do not fall back to the default.
Run `kit auth elevate --list-scopes --json` to inspect scopes without approval.

Only `y` or `yes`, without regard to case, confirms a plain prompt.
An empty answer, arbitrary text, input termination, or a 15-second timeout refuses approval.
Configured TOTP uses an authenticator code. Piped input cannot grant approval, even with a valid code.
The existing `KIT_ELEVATED=1` CI override remains separate and produces an audit event when a gate uses it.

A signed approval marker includes the canonical project directory and a unique grant ID.
A copied marker does not authorize another project. A directory alias resolves to the same project.
Legacy markers without project binding or a grant ID require fresh approval. A moved project also requires fresh approval.
Marker verification never creates or repairs a machine key. A malformed key prevents new approval.
The marker and local key do not protect against a principal that controls the machine-local authority or signing key.

Run `kit auth status --json` for `{ active, state }`. This inspects local approval, not provider credentials or permissions.
Run `kit auth revoke` to remove the project marker. A removal failure returns exit 1 and warns that approval may remain active.
Repeated removal succeeds when the marker is absent. Read-only mode refuses marker mutation and TOTP enrollment.
Kit stores current grant authority in `~/.kit/elevation-authority/grants.sqlite`, outside the project directory.
Restored markers cannot reactivate consumed, revoked, or superseded approval.
A new approval replaces the previous grant for that project. Directory aliases share the same authority.
Concurrent one-shot requests can consume one grant only once, including a grant with scope `all`.
Kit checks expiry again after it acquires the authority lock.
An older request cannot consume a replacement grant. Fresh approval permits another request in the same process.
The authority store requires trusted parent directories and a local filesystem with working SQLite locks.
Missing or unreadable authority refuses access. Inspection never creates the authority store.
A failed audit write refuses the operation after consumption. Request fresh approval before retrying.
The CI override permits one one-shot request per operation per process. It does not consume a separate human grant.

Run `kit auth setup-totp` to create the local authenticator secret and display its provisioning details.
Use `--issuer <name>` and `--account <name>` for labels. Existing enrollment requires explicit `--overwrite`.
Concurrent setup calls without `--overwrite` return one successful enrollment with a usable credential.
Kit publishes complete secret files. A failed competing setup cannot replace the winning credential.
Missing values, repeated flags, and flags from another auth subcommand fail before policy activation.

### TOTP recovery

Elevation refuses an unreadable, empty, whitespace-only, or malformed secret file. It also refuses
directories and symlinks, including dangling symlinks and symlinks to valid secrets. Only an absent
enrollment file permits the YES prompt when no environment secret is configured.

Repair the file, or run `kit auth setup-totp --overwrite` to replace a file or symlink. Symlink
replacement leaves the target unchanged. A new secret makes the old authenticator entry stop working.
The overwrite option cannot replace a directory. Move the directory aside and keep its contents.
Then run `kit auth setup-totp` to enroll a new secret. Do not delete the directory as a recovery step.

## External scanner reports

Run `kit ingest sarif report.sarif` or `kit ingest osv report.json`.
Add `--json` for structured output.
Use `--` before a report filename that starts with a hyphen.

The command reads one local report and prints normalized findings.
It does not store findings, launch a scanner, or contact a cloud service.
It also suppresses the normal post-command registry notices, including in interactive use.
The scanner adapters use the same strict parser when they feed the security verdict.

A successful import produces exit 0, including when the report contains findings with status `fail`.
That exit code confirms a valid import. It does not certify the account or resolve a finding.
Valid empty reports produce a count of zero.
Invalid JSON, invalid report structure, and read errors produce exit 1.
JSON errors contain `ok: false` and `error`, not a successful empty finding list.

The output states that an external report does not verify the current account state.
Displayed findings mask recognized credentials and remove terminal controls.
The parser retains original identities for other consumers.

## Global behavior

Help and version requests take precedence and do not run the inspection handler.
An existing invalid or unreadable configuration stops dispatch before read-only activation.
A missing configuration file retains each command's existing behavior.
Help and version remain available when configuration is invalid.
Initial read-only activation can append a local audit event.
That event does not grant permission for the inspection command to write.
Unknown flags are rejected before policy activation.
Hook gates use their blocking exit code, 2, for an unknown flag.
