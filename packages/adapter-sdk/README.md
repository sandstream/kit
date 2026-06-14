# sandstream-kit-adapter-sdk

Type definitions for building [kit](https://github.com/sandstream/kit) service adapters.

Install this package to write custom adapters without depending on the full kit codebase.

## Installation

```bash
npm install sandstream-kit-adapter-sdk
```

## Writing your first adapter

```typescript
import type { ServiceAdapter, AdapterContext, ProvisionResult } from "sandstream-kit-adapter-sdk";

export const myServiceAdapter: ServiceAdapter = {
  name: "my-company/my-service",
  description: "Provisions My Service API credentials",

  // Return empty array for API-based adapters (no CLI tool required)
  getRequiredTools: () => [],

  // Return true if the service is already provisioned (skip re-provisioning)
  check: async (ctx: AdapterContext): Promise<boolean> => {
    return !!ctx.existingEnv.MY_SERVICE_API_KEY;
  },

  // Provision the service and return secrets to write to .env.local
  provision: async (ctx: AdapterContext): Promise<ProvisionResult> => {
    const key = ctx.existingEnv.MY_SERVICE_API_KEY;

    // Key-reuse pattern: return existing key if already set
    if (key) {
      return {
        success: true,
        message: "MY_SERVICE_API_KEY already configured",
        secrets: { MY_SERVICE_API_KEY: key },
      };
    }

    // Guide the user to get a key if missing
    return {
      success: false,
      error: "Missing MY_SERVICE_API_KEY",
      message: [
        "Set MY_SERVICE_API_KEY in .env.local:",
        "1. Visit https://my-service.com/dashboard/api-keys",
        "2. Create a new API key",
        "3. Add to .env.local: MY_SERVICE_API_KEY=your_key_here",
      ].join("\n"),
    };
  },
};
```

## Registering your adapter as a plugin

Export your adapter from a package with the name `sandstream-kit-plugin-*` or `@scope/sandstream-kit-plugin-*`, then add it to your project's `package.json`:

```json
{
  "kitPlugins": ["sandstream-kit-plugin-my-service"]
}
```

Your package should export:

```typescript
// Either a single adapter:
export const adapter: ServiceAdapter = myServiceAdapter;

// Or multiple adapters:
export const adapters: ServiceAdapter[] = [myServiceAdapter, anotherAdapter];
```

## API

### `ServiceAdapter`

The main interface to implement for a custom adapter.

| Property | Type | Description |
|----------|------|-------------|
| `name` | `string` | Unique identifier, e.g. `"stripe/payments"` |
| `description` | `string` | Human-readable description |
| `getRequiredTools()` | `() => string[]` | CLI tools required (empty for API-based) |
| `check(ctx)` | `(ctx: AdapterContext) => Promise<boolean>` | Already provisioned? |
| `provision(ctx)` | `(ctx: AdapterContext) => Promise<ProvisionResult>` | Run provisioning |

### `AdapterContext`

Passed to `check()` and `provision()`.

| Property | Type | Description |
|----------|------|-------------|
| `projectPath` | `string` | Absolute path to project root |
| `projectName` | `string?` | Project name from config |
| `existingEnv` | `Record<string, string>` | Current `.env.local` contents |

### `ProvisionResult`

Return value from `provision()`.

| Property | Type | Description |
|----------|------|-------------|
| `success` | `boolean` | Whether provisioning succeeded |
| `message` | `string` | Human-readable result message |
| `secrets` | `Record<string, string>?` | Keys to write to `.env.local` |
| `config` | `Record<string, unknown>?` | Metadata for `skills-lock.json` |
| `error` | `string?` | Error message on failure |
