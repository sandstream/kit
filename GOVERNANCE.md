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
- Periodic check against revocation endpoint
- Immediately stop all operations if revoked
- Clear local secrets and caches
- Log revocation event

## Implementation Files

- `src/governance.ts` - Core governance logic
- `src/audit.ts` - Audit logging
- `src/approval.ts` - Human approval gates
- `src/revocation.ts` - Access revocation checks

## CLI Commands

- `kit governance check` - Check governance status
- `kit governance audit` - View audit log
- `kit governance revoke` - Revoke agent access locally

## Integration Points

All kit commands will:
1. Check governance.enabled flag
2. Verify environment permissions
3. Log operation to audit log
4. Check budget limits
5. Request approval if needed
6. Check revocation status
