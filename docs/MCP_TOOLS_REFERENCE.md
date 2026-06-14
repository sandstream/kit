# MCP Tools Quick Reference

## kit_configure

| Action | Params | Use Case |
|--------|--------|----------|
| **get** | `key` | Retrieve config value |
| **set** | `key`, `value`, `scope`, `category` | Update setting |
| **list** | `scope?`, `category?` | Browse configs |
| **validate** | `key`, `value` | Type-check before set |

**Scopes**: global \| project \| user  
**Categories**: adapter \| tool \| service \| path \| feature

---

## kit_adapter_check

| Action | Params | Returns |
|--------|--------|---------|
| **status** | `adapter` | overall_status, installed, configured, authenticated, checks[], recommendations[] |
| **dependencies** | `adapter` | name[], required, installed, version, compatible |
| **health** | `adapter` | healthy, uptime_seconds, error_count, success_count, avg_response_time_ms |

**Status Values**: healthy \| degraded \| unhealthy

---

## kit_adapter_install

| Action | Params | Returns |
|--------|--------|---------|
| **install** | `adapter`, `version?`, `auto_configure?` | installed, version, configured, setup_required, next_steps[] |
| **setup** | `adapter`, `mode`, `env_vars?` OR `responses?` | configured, env_vars_set[], message |
| **configure** | `adapter`, `key`, `value`, `required?` | key, value, adapter_name, set_at |

**Setup Modes**: auto \| interactive

---

## Response Format

All tools return:
```json
{
  "success": true,
  "data": { /* tool-specific data */ },
  "error": null
}
```

---

## Common Tasks

### Configure Database
```json
{ "action": "set", "key": "db.url", "value": "postgres://...", "scope": "project", "category": "service" }
```

### Install + Setup Adapter
```json
{ "action": "install", "adapter": "stripe" }
{ "action": "setup", "adapter": "stripe", "mode": "auto", "env_vars": { "key": "value" } }
```

### Check Adapter Health
```json
{ "action": "status", "adapter": "stripe" }
{ "action": "health", "adapter": "stripe" }
```

### List Project Features
```json
{ "action": "list", "scope": "project", "category": "feature" }
```

---

## Error Handling

```typescript
const result = await kit_configure({ action: "set", ... });
if (!result.success) {
  console.error(result.error);  // "Configuration key 'x' not found"
}
```

---

## Tool Status

- **Availability**: Claude Code + MCP-capable clients
- **Auth**: None (local operations)
- **Rate Limits**: None (local)
- **Latency**: <100ms typical
