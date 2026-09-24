# Plugin documentation reference examples

These are extended examples for a service-adapter package. Use the [documentation standards](./PLUGIN_DOCUMENTATION_STANDARDS.md) for required coverage. API clients and scanner-ingestion packages must document their own exports and behavior instead of copying adapter methods.

## API reference example

Full API documentation for the ServiceAdapter interface.

```markdown
# API Reference

## ServiceAdapter Interface

Kit plugins that provision services through `kit add` implement the `ServiceAdapter` interface. API and result-ingestion packages use their own exported APIs.

### Type Definition

\`\`\`typescript
interface ServiceAdapter {
  name: string;
  description: string;
  check(context: AdapterContext): Promise<boolean>;
  provision(context: AdapterContext): Promise<ProvisionResult>;
  getRequiredTools(): string[];
}
\`\`\`

### Properties

#### name: string

Unique identifier in format: `provider/service`

Examples:
- `stripe/payments`
- `supabase/database`
- `railway/hosting`

#### description: string

Human-readable description of what this adapter provisions (50-200 chars).

### Methods

#### check(context): Promise<boolean>

Verify if the service is already provisioned.

**Parameters:**
- `context: AdapterContext` - Project context and environment

**Returns:**
- `true` if already provisioned (skip provision)
- `false` if provisioning needed

**Example:**
\`\`\`typescript
async check(context: AdapterContext): Promise<boolean> {
  return !!context.existingEnv["SERVICE_API_KEY"];
}
\`\`\`

#### provision(context): Promise<ProvisionResult>

Perform actual provisioning. Should be idempotent.

**Parameters:**
- `context: AdapterContext` - Project context and environment

**Returns:** `ProvisionResult` with secrets and status

**Example:**
\`\`\`typescript
async provision(context: AdapterContext): Promise<ProvisionResult> {
  const key = context.existingEnv["SERVICE_API_KEY"];
  if (key) {
    return {
      success: true,
      message: "Already configured",
      secrets: { SERVICE_API_KEY: key },
    };
  }
  // ... actual provisioning
}
\`\`\`

#### getRequiredTools(): string[]

List CLI tools needed for this adapter.

**Returns:** Array of tool names (e.g., `["stripe-cli", "terraform"]`)

**Example:**
\`\`\`typescript
getRequiredTools(): string[] {
  return ["aws-cli", "terraform"];
}
\`\`\`

## AdapterContext

Information provided to your adapter methods.

\`\`\`typescript
interface AdapterContext {
  projectName?: string;           // Project name if available
  projectPath: string;            // Absolute path to project
  existingEnv: Record<string, string>;  // Environment variables
}
\`\`\`

## ProvisionResult

Result returned from `provision()` method.

\`\`\`typescript
interface ProvisionResult {
  success: boolean;               // Did it succeed?
  message: string;                // Human-readable message
  secrets?: Record<string, string>;    // Secrets for .env.local
  config?: Record<string, unknown>;    // Metadata for lock files
  error?: string;                 // Error code if failed
}
\`\`\`

## Common Patterns

### Key-Reuse Pattern

Always check for existing credentials before making API calls:

\`\`\`typescript
async provision(context: AdapterContext): Promise<ProvisionResult> {
  const existing = context.existingEnv["API_KEY"];
  if (existing) {
    return { success: true, secrets: { API_KEY: existing } };
  }
  // Only provision if missing
}
\`\`\`

### Multiple Credentials

Return all related secrets together:

\`\`\`typescript
return {
  success: true,
  secrets: {
    DATABASE_URL: "postgresql://...",
    DATABASE_HOST: "db.example.com",
    DATABASE_PORT: "5432",
    DATABASE_NAME: "myapp",
  },
};
\`\`\`

### Error with Instructions

Provide actionable error messages:

\`\`\`typescript
return {
  success: false,
  error: "missing_credentials",
  message: [
    "Set up SERVICE_API_KEY:",
    "1. Go to https://dashboard.example.com/api-keys",
    "2. Create a new key",
    "3. Add to .env.local: SERVICE_API_KEY=key_here",
  ].join("\n"),
};
\`\`\`
```

## Configuration example

Environment variables and configuration options.

```markdown
# Configuration Guide

## Environment Variables

### Required

| Variable | Description | Example |
|----------|-------------|---------|
| `SERVICE_API_KEY` | API authentication key | `sk_live_...` |
| `SERVICE_WEBHOOK_SECRET` | Webhook signing secret | `whsec_...` |

### Optional

| Variable | Description | Default |
|----------|-------------|---------|
| `SERVICE_BASE_URL` | Custom API endpoint | `https://api.service.com` |
| `SERVICE_TIMEOUT` | Request timeout (ms) | `30000` |
| `SERVICE_RETRY_COUNT` | Retry failed requests | `3` |

## Setup Instructions

### For Development

1. Create account at https://example.com
2. Navigate to Settings > API Keys
3. Generate a new key
4. Add to `.env.local`:
   ```
   SERVICE_API_KEY=sk_test_...
   SERVICE_WEBHOOK_SECRET=whsec_...
   ```

### For Production

Same as development, but use production credentials:
```
SERVICE_API_KEY=sk_live_...
SERVICE_WEBHOOK_SECRET=whsec_live_...
```

## Advanced Configuration

### Custom Endpoints

Override API endpoint for self-hosted instances:

```env
SERVICE_BASE_URL=https://api.internal.example.com
SERVICE_API_KEY=your_key
```

### Timeouts and Retries

Configure request behavior:

```env
SERVICE_TIMEOUT=60000          # 60 second timeout
SERVICE_RETRY_COUNT=5          # Retry 5 times
SERVICE_RETRY_DELAY=1000       # 1 second between retries
```
```

## Usage examples

Usage examples for different scenarios.

```markdown
# Usage Examples

## Basic Setup

```typescript
import { adapter } from "@provider/kit-service";

const context = {
  projectPath: process.cwd(),
  existingEnv: process.env,
};

// Check if already configured
const isConfigured = await adapter.check(context);
console.log(isConfigured); // true or false

// Provision if needed
const result = await adapter.provision(context);
if (result.success) {
  console.log("Configured! Secrets:", result.secrets);
}
```

## In kit Projects

Adapters ship inside a plugin package, and kit discovers them from the `kitPlugins`
array in `package.json` (`loadPluginAdapters`). `.kit.toml` has no `[adapters]`
section — the adapter names a plugin exports are what `kit add` then offers.

```json
{ "kitPlugins": ["@acme/kit-stripe", "@acme/kit-supabase"] }
```

Then use CLI:
```bash
kit add stripe/payments
```

## Checking Status

```typescript
if (await adapter.check(context)) {
  console.log("Service is ready to use");
} else {
  console.log("Run kit setup to configure");
}
```

## Handling Errors

```typescript
const result = await adapter.provision(context);

if (!result.success) {
  console.error("Setup failed:", result.message);
  if (result.error === "missing_credentials") {
    console.log("Follow the setup instructions above");
  }
}
```
```

## Testing example

Testing guidelines for plugins.

```markdown
# Testing Guide

## Test Structure

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { adapter } from "./plugin.js";

const ctx = (env = {}) => ({
  projectPath: "/tmp/test",
  projectName: "test-app",
  existingEnv: env,
});

describe("Plugin Name", () => {
  // Tests here
});
```

## Test Checklist

- [ ] Adapter has correct name format (provider/service)
- [ ] check() returns true when configured
- [ ] check() returns false when missing
- [ ] provision() returns success=true on valid credentials
- [ ] provision() returns error when credentials missing
- [ ] provision() implements key-reuse pattern
- [ ] getRequiredTools() lists all required CLIs
- [ ] Error messages are actionable
- [ ] All tests pass locally

## Common Test Patterns

```typescript
// Test with missing credentials
it("check returns false when key absent", async () => {
  assert.equal(await adapter.check(ctx()), false);
});

// Test with existing credentials
it("check returns true when key present", async () => {
  const result = await adapter.check(ctx({ API_KEY: "test" }));
  assert.equal(result, true);
});

// Test error handling
it("provision returns error with helpful message", async () => {
  const result = await adapter.provision(ctx());
  assert.equal(result.success, false);
  assert.match(result.message, /setup|instructions/i);
});
```

## Running Tests

```bash
npm test
```

Expected output:
```
# tests 10
# pass 10
# fail 0
```
```
