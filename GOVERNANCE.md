# kit Governance & Access Control

## Overview

Governance features for managing agent access to production systems, secrets, and destructive operations.

## Configuration Schema

```toml
[governance]
enabled = true
environment = "dev"  # dev, staging, prod

[governance.access]
# Environment-based permissions
dev = { read = true, write = true, delete = true }
staging = { read = true, write = true, delete = false }
prod = { read = true, write = false, delete = false }

[governance.agent]
# Agent identification and limits
id = "00000000-0000-0000-0000-000000000000"
name = "Founding Engineer"
max_tokens_per_day = 1000000
max_operations_per_hour = 100

[governance.audit]
# Audit logging configuration
enabled = true
log_file = ".kit-audit.jsonl"
log_level = "info"  # debug, info, warn, error
include_secrets = false  # Never log secret values

[governance.approval]
# Operations requiring human approval
destructive_operations = ["delete", "drop", "truncate", "destroy"]
production_writes = true
secret_rotations = false
approval_timeout = 3600  # seconds

[governance.secrets]
# Secret lifecycle management
check_expiration = true
warn_days_before_expiry = 30
rotate_on_expiry = false
revoke_on_agent_disable = true

[governance.revocation]
# Emergency access revocation
enabled = true
check_interval = 300  # seconds
revocation_endpoint = "https://audit.example.com/agents/{agent_id}/status"
```

## Features

### 1. Environment-Based Access Control

Different permission levels per environment:
- **dev**: Full access (read/write/delete)
- **staging**: Read/write only (no delete)
- **prod**: Read-only by default

### 2. Audit Logging

All operations logged to `.kit-audit.jsonl`:

```json
{
  "timestamp": "2026-03-30T10:15:30.000Z",
  "agent_id": "00000000-0000-0000-0000-000000000000",
  "agent_name": "Founding Engineer",
  "operation": "secrets.generate",
  "environment": "dev",
  "success": true,
  "duration_ms": 1234,
  "metadata": {
    "keys_resolved": 5,
    "store": "infisical"
  }
}
```

### 3. Agent Budget Limits

Track token usage and operation counts:
- Max tokens per day
- Max operations per hour
- Block when limits exceeded
- Reset at midnight (tokens) or hourly (operations)

Governed CLI and MCP operations charge the requested project's allowance before execution.
A shared local lock serializes admission. The operation itself runs after that lock is released.
A returned failure keeps the charge. A thrown error refunds its charge when storage permits.
Process crashes keep the charge until the normal reset. Failed refunds remain visible in the audit.
Read-only mode does not write accounting state. Inspection alone does not reserve allowance.
See [budget behavior and limits](docs/INSPECTION_COMMANDS.md) for storage and concurrency requirements.

### 4. Approval Gates

Destructive operations require human approval:
- Detect destructive keywords in commands
- Prompt for approval via CLI
- Optional webhook notification
- Timeout after configured duration

### 5. Secret Expiration Monitoring

Track and alert on secret expiration:
- Check expiration dates from secret stores
- Warn N days before expiry
- Optional auto-rotation
- Block operations when secrets expired

### 6. Access Revocation

Emergency kill-switch for agent access:
- Check the configured endpoint before governed operations, subject to the cache interval.
- Refuse the operation when access is revoked or cannot be verified.
- Record the denial when audit logging is enabled.
- Return the denial to the caller without terminating its process.

The cache distinguishes the canonical target project directory, endpoint, and agent ID. Directory aliases share one identity.
The default interval is 300 seconds. Set `check_interval = 0` to check before every operation.
The cache uses elapsed time, so clock changes cannot extend a permission.
A forced refresh invalidates an earlier permission. A failed refresh cannot restore it.
Concurrent checks for the same identity wait for an active latest request.
Completed results remain subject to the interval, even when an older request remains active.
Failures are not cached as confirmed revocation, so a recovered endpoint can immediately restore access.

Inspection and enforcement use the same response parser and a five-second request limit.
The response must contain a boolean `revoked` field. Endpoint errors produce an unverified denial.
Identity substitution must preserve the endpoint path. A dot segment that changes the path is refused before the request.

Containment gap: this check does not terminate operations already running or erase provider credentials.
Those capabilities remain outside this implemented check. Provider revocation requires a separate action.

## Implementation Files

- `src/governance.ts` - Core governance logic
- `src/audit.ts` - Audit logging
- `src/approval.ts` - Human approval gates
- `src/revocation.ts` - Access revocation checks

## CLI Commands

- `kit governance [status]`: Show effective configuration, fresh revocation status, budget usage, and agent information. `status` is an alias.
- `kit audit` - View the audit log.

## Integration Points

All kit commands will:
1. Check governance.enabled flag
2. Verify environment permissions
3. Log operation to audit log
4. Check budget limits
5. Request approval if needed
6. Check revocation status
