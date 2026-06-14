# kit Plugin Development Guide

This guide helps you create, test, and publish ServiceAdapter plugins for the kit ecosystem.

## Quick Start

```bash
# Scaffold a new plugin
kit plugin scaffold my-service

# Navigate to the plugin directory
cd kit-plugin-my-service

# Edit the adapter implementation
vim src/my-service.ts

# Build and test
npm run build
npm test

# Publish to npm
npm publish
```

## Understanding Plugins

A **kit plugin** is a TypeScript package that implements the `ServiceAdapter` interface. It enables kit to automatically provision external services (payment processors, databases, hosting platforms, etc.) in development and production environments.

### Core Concepts

**ServiceAdapter**: The interface that defines a provisioning adapter.

```typescript
export interface ServiceAdapter {
  name: string;                    // "provider/service" (e.g., "stripe/payments")
  description: string;             // Human-readable description
  check(context): Promise<boolean>;        // Returns true if already provisioned
  provision(context): Promise<ProvisionResult>;  // Performs provisioning
  getRequiredTools(): string[];    // CLI tools needed for this adapter
}
```

**AdapterContext**: Information provided to your adapter.

```typescript
interface AdapterContext {
  projectName?: string;            // Name of the project
  projectPath: string;             // Absolute path to project directory
  existingEnv: Record<string, string>;  // Environment variables from .env.local
}
```

**ProvisionResult**: The outcome of provisioning.

```typescript
interface ProvisionResult {
  success: boolean;                // Did provisioning succeed?
  message: string;                 // Human-readable message
  secrets?: Record<string, string>;     // Secrets to write to .env.local
  config?: Record<string, unknown>;    // Config metadata for lock files
  error?: string;                  // Error code if failed
}
```

## Adapter Patterns

### Pattern 1: API-Based Service (No CLI Tools)

For services that only need an API key:

```typescript
import type { ServiceAdapter, AdapterContext, ProvisionResult } from "sandstream-kit-adapter-sdk";

export const stripeAdapter: ServiceAdapter = {
  name: "stripe/payments",
  description: "Stripe payment processing",
  
  getRequiredTools(): string[] {
    return []; // No CLI tools needed
  },
  
  async check(context: AdapterContext): Promise<boolean> {
    return !!context.existingEnv["STRIPE_SECRET_KEY"];
  },
  
  async provision(context: AdapterContext): Promise<ProvisionResult> {
    const key = context.existingEnv["STRIPE_SECRET_KEY"];
    
    if (key) {
      return {
        success: true,
        message: "Stripe already configured",
        secrets: { STRIPE_SECRET_KEY: key },
      };
    }
    
    return {
      success: false,
      error: "missing_api_key",
      message: `Get your API key from https://dashboard.stripe.com/apikeys\nSet STRIPE_SECRET_KEY in .env.local`,
    };
  },
};
```

### Pattern 2: CLI-Based Service

For services with a CLI tool:

```typescript
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export const flyioAdapter: ServiceAdapter = {
  name: "flyio/hosting",
  description: "Fly.io deployment",
  
  getRequiredTools(): string[] {
    return ["fly"]; // Requires `fly` CLI
  },
  
  async check(context: AdapterContext): Promise<boolean> {
    // Check if fly CLI is authenticated
    try {
      await exec("fly", ["auth", "whoami"]);
      return true;
    } catch {
      return false;
    }
  },
  
  async provision(context: AdapterContext): Promise<ProvisionResult> {
    try {
      const { stdout } = await exec("fly", ["auth", "whoami"]);
      return {
        success: true,
        message: `Logged in as: ${stdout.trim()}`,
        secrets: {}, // No secrets needed, CLI handles auth
      };
    } catch (err) {
      return {
        success: false,
        error: "not_authenticated",
        message: "Run: fly auth login",
      };
    }
  },
};
```

### Pattern 3: Key-Reuse (Avoid Redundant Calls)

Always check for existing credentials first to avoid unnecessary API calls:

```typescript
async provision(context: AdapterContext): Promise<ProvisionResult> {
  // Pattern: Check existingEnv before making API calls
  const existingToken = context.existingEnv["SERVICE_TOKEN"];
  const existingAppId = context.existingEnv["SERVICE_APP_ID"];
  
  // If already fully configured, just return existing values
  if (existingToken && existingAppId) {
    return {
      success: true,
      message: "Service already configured",
      secrets: {
        SERVICE_TOKEN: existingToken,
        SERVICE_APP_ID: existingAppId,
      },
    };
  }
  
  // Only provision what's missing
  // ...
}
```

### Pattern 4: Structured Credentials

For services requiring multiple credentials:

```typescript
async provision(context: AdapterContext): Promise<ProvisionResult> {
  const result = {
    success: true,
    message: "PostgreSQL configured",
    secrets: {
      DATABASE_URL: "postgresql://user:pass@host:5432/db",
      DATABASE_HOST: "localhost",
      DATABASE_PORT: "5432",
      DATABASE_NAME: "myapp",
      DATABASE_USER: "postgres",
      DATABASE_PASSWORD: "secret123",
    },
  };
  
  return result;
}
```

## Testing Your Adapter

The scaffold generates a test file. Enhance it with your specific logic:

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { myAdapter } from "./my-service.js";

const ctx = (env: Record<string, string> = {}) => ({
  projectPath: "/tmp/test",
  projectName: "test-app",
  existingEnv: env,
});

describe("myAdapter", () => {
  it("should detect already-configured service", async () => {
    const result = await myAdapter.check(ctx({ MY_KEY: "abc123" }));
    assert.equal(result, true);
  });
  
  it("should provision when not configured", async () => {
    const result = await myAdapter.provision(ctx());
    assert.equal(result.success, false); // Missing credentials
    assert.ok(result.error); // Error code provided
  });
  
  it("should return secrets on successful provision", async () => {
    const result = await myAdapter.provision(ctx({ MY_KEY: "abc" }));
    assert.equal(result.success, true);
    assert.ok(result.secrets);
    assert.equal(result.secrets.MY_KEY, "abc");
  });
});
```

## Publishing Your Plugin

### 1. Prepare for Publication

```bash
cd kit-plugin-my-service

# Ensure tests pass
npm test

# Build production bundle
npm run build

# Update package.json version
npm version patch  # or minor, major
```

### 2. Publish to npm

```bash
# Option A: Using npm CLI
npm publish

# Option B: Using npm token
npm set //registry.npmjs.org/:_authToken YOUR_TOKEN
npm publish
```

### 3. Register with kit Plugin Registry

To add your plugin to the official registry:

1. Create a pull request to [kit Repository](https://github.com/sandstream/kit)
2. Update `src/plugins.ts` DEFAULT_REGISTRY
3. Follow the metadata format:

```typescript
{
  name: "mycompany/service",           // provider/service format
  description: "What this provisions",
  version: "1.0.0",
  author: "Your Name",
  license: "MIT",
  repository: "https://github.com/yourname/kit-myservice",
  package: "@mycompany/kit-myservice",
  kitVersion: ">=0.1.0",
  tags: ["category1", "category2"],
  published: "2026-04-15T00:00:00Z",
  downloads: 0,
  rating: 5.0,
  install: "npm install @mycompany/kit-myservice",
}
```

## Best Practices

### ✅ DO

- **Be Idempotent**: Running provision() twice should be safe
- **Reuse Keys**: Check for existing credentials before making API calls
- **Clear Messages**: Provide actionable error messages with setup URLs
- **Handle Missing CLIs**: Return helpful error if required CLI tool is missing
- **Use Structured Secrets**: Return multiple related secrets in ProvisionResult
- **Write Tests**: Test both success and failure paths
- **Document Setup**: Include README with manual setup instructions

### ❌ DON'T

- **Assume CLIs Exist**: Always check getRequiredTools()
- **Store Sensitive Data**: Never log or store API keys
- **Make Unnecessary Calls**: Use key-reuse pattern
- **Break Idempotency**: Avoid state mutations that differ on second run
- **Generic Errors**: "Failed to provision" tells users nothing
- **Hardcode Paths**: Use context.projectPath for file operations

## Example: Complete Adapter

```typescript
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ServiceAdapter, AdapterContext, ProvisionResult } from "sandstream-kit-adapter-sdk";

const exec = promisify(execFile);

/**
 * PostgreSQL via Neon adapter
 * 
 * Provisions serverless PostgreSQL databases with:
 * - Automatic project creation
 * - Connection string generation
 * - Environment variable setup
 */
export const neonDbAdapter: ServiceAdapter = {
  name: "neon/database",
  description: "Serverless PostgreSQL via Neon",
  
  getRequiredTools(): string[] {
    return []; // API-based, no CLI needed
  },
  
  async check(context: AdapterContext): Promise<boolean> {
    // Check if Neon API key and database URL are configured
    return !!(
      context.existingEnv["NEON_API_KEY"] &&
      context.existingEnv["DATABASE_URL"]
    );
  },
  
  async provision(context: AdapterContext): Promise<ProvisionResult> {
    // Key-reuse pattern: return existing if already configured
    if (
      context.existingEnv["NEON_API_KEY"] &&
      context.existingEnv["DATABASE_URL"]
    ) {
      return {
        success: true,
        message: "Neon database already configured",
        secrets: {
          NEON_API_KEY: context.existingEnv["NEON_API_KEY"],
          DATABASE_URL: context.existingEnv["DATABASE_URL"],
        },
      };
    }
    
    // User needs to set up manually
    return {
      success: false,
      error: "missing_credentials",
      message: `Configure Neon database:
      
1. Go to https://console.neon.tech
2. Create a new project
3. Copy the connection string
4. Set in .env.local:
   DATABASE_URL=postgresql://user:password@host/dbname
   NEON_API_KEY=neon_api_key_here`,
    };
  },
};
```

## Troubleshooting

### Plugin won't build

- Check TypeScript errors: `npm run build` should output errors
- Verify imports are correct (especially `sandstream-kit-adapter-sdk`)
- Ensure Node.js 22+ is installed

### Tests fail

- Run with verbose output: `npm test -- --verbose`
- Check that context mock is correct
- Verify async/await syntax is correct

### Installation fails

- Ensure package.json has correct metadata
- Check that `files` array includes `dist/` and `dist/**/*.d.ts`
- Verify npm token is set if publishing to private registry

## Resources

- [ServiceAdapter API Reference](https://github.com/sandstream/kit/tree/main/packages/adapter-sdk)
- [Official Plugins](https://github.com/sandstream/kit/tree/main/src/adapters)
- [Plugin Registry](https://github.com/sandstream/kit/blob/main/src/plugins.ts)
