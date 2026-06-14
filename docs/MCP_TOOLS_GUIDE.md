# kit MCP Tools Guide

kit exposes configuration, adapter, and health management via three MCP tools for Claude Code and other AI assistants.

## Tools Overview

| Tool | Purpose | Phase |
|------|---------|-------|
| `kit_configure` | Manage project configuration, feature flags, paths | 6C-1a |
| `kit_adapter_check` | Check adapter health, dependencies, status | 6C-1b |
| `kit_adapter_install` | Install, configure, setup adapters with env vars | 6C-1c |

## kit_configure

Configuration management: get/set/list/validate project settings.

### Actions

**get** — Retrieve configuration value
```typescript
{
  action: "get",
  key: "app.debug"
}
```

**set** — Update configuration
```typescript
{
  action: "set",
  key: "db.host",
  value: "localhost",
  scope: "project",  // global | project | user
  category: "service"  // adapter | tool | service | path | feature
}
```

**list** — Filter configurations
```typescript
{
  action: "list",
  scope: "project",
  category: "feature"
}
```

**validate** — Type-check before setting
```typescript
{
  action: "validate",
  key: "port",
  value: "8080"
}
```

### Examples

```typescript
// Set database configuration
kit_configure {
  action: "set",
  key: "database.url",
  value: "postgres://localhost:5432/myapp",
  scope: "project",
  category: "service"
}

// Enable feature flag
kit_configure {
  action: "set",
  key: "feature.dark_mode",
  value: "true",
  scope: "project",
  category: "feature"
}

// List all project-level features
kit_configure {
  action: "list",
  scope: "project",
  category: "feature"
}
```

## kit_adapter_check

Adapter health monitoring: status, dependencies, metrics.

### Actions

**status** — Full adapter check with recommendations
```typescript
{
  action: "status",
  adapter: "stripe"
}
```
Returns: overall_status (healthy|degraded|unhealthy), installed, configured, authenticated, checks[], recommendations[]

**dependencies** — Check required tools
```typescript
{
  action: "dependencies",
  adapter: "github"
}
```
Returns: name, required, installed, version, compatible

**health** — Performance metrics
```typescript
{
  action: "health",
  adapter: "sendgrid"
}
```
Returns: uptime_seconds, error_count, success_count, average_response_time_ms

### Examples

```typescript
// Check if Stripe is ready
kit_adapter_check {
  action: "status",
  adapter: "stripe"
}

// Verify GitHub CLI installed
kit_adapter_check {
  action: "dependencies",
  adapter: "github"
}

// Monitor adapter performance
kit_adapter_check {
  action: "health",
  adapter: "datadog"
}
```

## kit_adapter_install

Adapter provisioning: install, auto/interactive setup, env var management.

### Actions

**install** — Install adapter
```typescript
{
  action: "install",
  adapter: "slack",
  version: "1.0.0",
  auto_configure: false
}
```
Returns: installed, version, configured, setup_required, next_steps

**setup** — Configure with environment variables
```typescript
{
  action: "setup",
  adapter: "github",
  mode: "auto",  // auto | interactive
  env_vars: {
    token: "ghp_...",
    owner: "myorg"
  }
}
```

**configure** — Set individual env var
```typescript
{
  action: "configure",
  key: "API_KEY",
  value: "sk_test_...",
  adapter: "stripe",
  required: true
}
```

### Examples

```typescript
// Install Stripe adapter
kit_adapter_install {
  action: "install",
  adapter: "stripe",
  version: "2.0.0"
}

// Auto-configure with env vars
kit_adapter_install {
  action: "setup",
  adapter: "stripe",
  mode: "auto",
  env_vars: {
    secret_key: "sk_test_...",
    publishable_key: "pk_test_..."
  }
}

// Set single env var
kit_adapter_install {
  action: "configure",
  key: "STRIPE_API_KEY",
  value: "sk_live_...",
  adapter: "stripe"
}
```

## Common Workflows

### Setup New Adapter
```typescript
// 1. Install
kit_adapter_install {
  action: "install",
  adapter: "sendgrid",
  version: "latest"
}

// 2. Configure
kit_adapter_install {
  action: "setup",
  adapter: "sendgrid",
  mode: "auto",
  env_vars: {
    api_key: "SG.xxxxx"
  }
}

// 3. Verify
kit_adapter_check {
  action: "status",
  adapter: "sendgrid"
}
```

### Configure Project

```typescript
// Set database
kit_configure {
  action: "set",
  key: "database.url",
  value: "postgres://...",
  scope: "project",
  category: "service"
}

// Enable features
kit_configure {
  action: "set",
  key: "feature.analytics",
  value: "true",
  scope: "project",
  category: "feature"
}

// List what's configured
kit_configure {
  action: "list",
  scope: "project"
}
```

### Diagnose Issues

```typescript
// Check adapter health
kit_adapter_check {
  action: "status",
  adapter: "github"
}

// Verify dependencies
kit_adapter_check {
  action: "dependencies",
  adapter: "github"
}

// Get performance metrics
kit_adapter_check {
  action: "health",
  adapter: "github"
}
```

## Response Formats

All tools return `{ success: boolean, data?: T, error?: string }`.

### Success Response
```json
{
  "success": true,
  "data": {
    "adapter_name": "stripe",
    "installed": true,
    "configured": true,
    "version": "2.0.0"
  }
}
```

### Error Response
```json
{
  "success": false,
  "error": "Adapter 'nonexistent' not found"
}
```

## Tool Availability

- **Requires MCP Connection**: Use in Claude Code or MCP-capable clients
- **Scope**: Project-level configuration and adapter management
- **Auth**: No authentication required (operates on local config)
- **Rate Limits**: None (local operations)
