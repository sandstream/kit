# Creating Custom Service Adapters

kit service adapters enable automated provisioning of third-party services without browser interaction. This guide explains how to create your own adapters.

## Overview

An adapter is a TypeScript module that implements the `ServiceAdapter` interface. It handles:
1. Checking if a service is already provisioned
2. Provisioning the service (authenticating, creating resources, extracting credentials)
3. Declaring required CLI tools

## Quick Start

Here's a minimal adapter that provisions a fictional service called "MyService":

```typescript
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ServiceAdapter, AdapterContext, ProvisionResult } from "./types.js";

const exec = promisify(execFile);

export const myServiceAdapter: ServiceAdapter = {
  name: "myservice/api",
  description: "MyService API provisioning with authentication",
  
  getRequiredTools(): string[] {
    return ["myservice"];  // CLI tool that must be installed
  },
  
  async check(context: AdapterContext): Promise<boolean> {
    // Return true if already provisioned
    return !!context.existingEnv.MYSERVICE_API_KEY;
  },
  
  async provision(context: AdapterContext): Promise<ProvisionResult> {
    try {
      // 1. Ensure CLI is authenticated
      await exec("myservice", ["auth", "whoami"], { timeout: 5_000 });
      
      // 2. Create project/resources
      const projectName = context.projectName || "default";
      const { stdout } = await exec("myservice", [
        "projects", "create", "--name", projectName
      ], { timeout: 30_000 });
      
      // 3. Extract credentials
      const apiKeyMatch = stdout.match(/API Key: (\S+)/);
      if (!apiKeyMatch) {
        return {
          success: false,
          error: "Could not extract API key from output",
          message: "Failed to provision MyService",
        };
      }
      
      // 4. Return secrets and config
      return {
        success: true,
        message: "MyService provisioned successfully",
        secrets: {
          MYSERVICE_API_KEY: apiKeyMatch[1],
          MYSERVICE_PROJECT_ID: projectName,
        },
        config: {
          service: "myservice/api",
          projectName,
        },
      };
    } catch (error: unknown) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
        message: "Failed to provision MyService",
      };
    }
  },
};
```

## Interface Details

### ServiceAdapter

```typescript
interface ServiceAdapter {
  name: string;              // Unique identifier (e.g., "stripe/payments")
  description: string;       // Human-readable description
  check(context): Promise<boolean>;     // Is service already provisioned?
  provision(context): Promise<ProvisionResult>;  // Provision the service
  getRequiredTools(): string[];  // Required CLI tools
}
```

### AdapterContext

Passed to `check()` and `provision()`:

```typescript
interface AdapterContext {
  projectName?: string;      // Project name from CLI args
  projectPath: string;       // Absolute path to project
  existingEnv: Record<string, string>;  // Current .env.local contents
}
```

### ProvisionResult

Returned from `provision()`:

```typescript
interface ProvisionResult {
  success: boolean;          // Did provisioning succeed?
  message: string;           // Human-readable result message
  secrets?: Record<string, string>;   // Secrets to write to .env.local
  config?: Record<string, unknown>;   // Metadata for skills-lock.json
  error?: string;            // Error message if failed
}
```

## Real-World Example: Stripe Payments

Let's walk through the Stripe adapter from `src/adapters/stripe-payments.ts`:

### 1. Check if Already Provisioned

```typescript
async check(context: AdapterContext): Promise<boolean> {
  // First check .env.local for existing keys
  if (context.existingEnv.STRIPE_SECRET_KEY && 
      context.existingEnv.STRIPE_PUBLISHABLE_KEY) {
    return true;
  }
  
  // Then check if Stripe CLI is authenticated
  try {
    const { stdout } = await exec("stripe", ["config", "--list"], {
      timeout: 10_000,
    });
    return stdout.includes("test_mode_api_key");
  } catch {
    return false;
  }
}
```

**Best practices:**
- Check environment variables first (fastest)
- Fall back to CLI checks if needed
- Return `false` on any error (safer to re-provision than assume success)

### 2. Provision the Service

```typescript
async provision(context: AdapterContext): Promise<ProvisionResult> {
  // Step 1: Verify authentication
  const { stdout: configOutput } = await exec("stripe", ["config", "--list"]);
  if (!configOutput.includes("test_mode_api_key")) {
    return {
      success: false,
      error: "Stripe CLI not authenticated. Run: stripe login",
      message: "Please authenticate with Stripe CLI first",
    };
  }
  
  // Step 2: Extract credentials
  const testKeyMatch = configOutput.match(/test_mode_api_key\s*=\s*(\S+)/);
  const secretKey = testKeyMatch[1];
  const publishableKey = secretKey.replace("sk_test_", "pk_test_");
  
  // Step 3: (Optional) Create resources
  await exec("stripe", ["products", "create", "--name", "Subscription"]);
  
  // Step 4: Return result
  return {
    success: true,
    message: "Stripe payments configured successfully",
    secrets: {
      STRIPE_SECRET_KEY: secretKey,
      STRIPE_PUBLISHABLE_KEY: publishableKey,
    },
    config: {
      service: "stripe/payments",
      mode: "test",
    },
  };
}
```

**Key patterns:**
1. **Authenticate first** — Verify the CLI is logged in before making API calls
2. **Extract credentials** — Parse CLI output to get API keys/tokens
3. **Create resources** — Set up projects, API keys, webhooks, etc.
4. **Return structured data** — Secrets go to `.env.local`, config goes to `skills-lock.json`

## Testing Your Adapter

### Unit Tests

Create a test file `src/adapters/my-service.test.ts`:

```typescript
import { describe, it } from "node:test";
import assert from "node:assert";
import { myServiceAdapter } from "./my-service.js";

describe("myServiceAdapter", () => {
  it("returns false when not provisioned", async () => {
    const result = await myServiceAdapter.check({
      projectPath: "/tmp/test",
      existingEnv: {},
    });
    assert.strictEqual(result, false);
  });
  
  it("returns true when API key exists", async () => {
    const result = await myServiceAdapter.check({
      projectPath: "/tmp/test",
      existingEnv: { MYSERVICE_API_KEY: "test-key" },
    });
    assert.strictEqual(result, true);
  });
});
```

### Integration Testing

Test the full provisioning flow:

```bash
# 1. Install your service's CLI
brew install myservice-cli

# 2. Authenticate
myservice login

# 3. Test the adapter
cd /path/to/kit
npm run build
node dist/cli.js add myservice/api
```

## Registering Your Adapter

Add your adapter to `src/adapters/index.ts`:

```typescript
import { myServiceAdapter } from "./my-service.js";

export const adapters: AdapterRegistry = {
  "stripe/payments": stripePaymentsAdapter,
  "supabase/db": supabaseDbAdapter,
  "vercel/hosting": vercelHostingAdapter,
  "myservice/api": myServiceAdapter,  // Add here
};
```

## Best Practices

### 1. Error Handling

Always wrap CLI calls in try-catch and return structured errors:

```typescript
try {
  await exec("myservice", ["create-project"]);
} catch (error: unknown) {
  return {
    success: false,
    error: error instanceof Error ? error.message : "Unknown error",
    message: "Failed to create project",
  };
}
```

### 2. Timeouts

Set reasonable timeouts for CLI commands:

```typescript
await exec("myservice", ["slow-command"], {
  timeout: 60_000,  // 60 seconds
});
```

### 3. Idempotency

Design your adapter to be safe to run multiple times:

```typescript
async provision(context) {
  // Check if project already exists
  const { stdout } = await exec("myservice", ["projects", "list"]);
  if (stdout.includes(context.projectName)) {
    // Use existing project instead of creating new one
    return { success: true, message: "Using existing project" };
  }
  
  // Create new project
  await exec("myservice", ["projects", "create", context.projectName]);
  // ...
}
```

### 4. Secrets Hygiene

- Never log secrets to console
- Use structured secret names (e.g., `SERVICE_API_KEY`)
- Store only necessary secrets

### 5. Config Metadata

Store useful metadata in `config` for debugging:

```typescript
return {
  success: true,
  config: {
    service: "myservice/api",
    projectId: "proj-123",
    region: "us-east-1",
    provisionedAt: new Date().toISOString(),  // Added automatically by kit
  },
};
```

## Advanced Patterns

### Interactive Prompts

For services that require user input:

```typescript
import readline from "node:readline/promises";

async provision(context) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  
  const projectName = await rl.question("Project name: ");
  const region = await rl.question("Region (us-east-1): ") || "us-east-1";
  
  rl.close();
  
  // Use the inputs
  await exec("myservice", ["create", "--name", projectName, "--region", region]);
  // ...
}
```

### Multiple Authentication Methods

Support both CLI and API key auth:

```typescript
async check(context) {
  // Method 1: Environment variable
  if (context.existingEnv.MYSERVICE_API_KEY) {
    return true;
  }
  
  // Method 2: CLI authentication
  try {
    await exec("myservice", ["whoami"]);
    return true;
  } catch {
    return false;
  }
}
```

### Resource Dependencies

If your service depends on another:

```typescript
async provision(context) {
  // Check for required secrets from other services
  if (!context.existingEnv.DATABASE_URL) {
    return {
      success: false,
      error: "Missing DATABASE_URL",
      message: "Provision database first: kit add supabase/db",
    };
  }
  
  // Continue with provisioning
  // ...
}
```

## Troubleshooting

### Common Issues

**1. "Required tool not installed"**
- Ensure the CLI is in PATH: `which myservice`
- Check `getRequiredTools()` returns correct tool name
- Install the CLI: `brew install myservice-cli`

**2. "Provisioning succeeded but secrets not in .env.local"**
- Verify your adapter returns secrets in the correct format:
  ```typescript
  return { secrets: { KEY_NAME: "value" } };  // ✅ Correct
  return { secrets: "KEY=value" };            // ❌ Wrong
  ```

**3. "CLI command hangs forever"**
- Always set a timeout:
  ```typescript
  await exec("myservice", ["command"], { timeout: 30_000 });
  ```

**4. "Authentication fails"**
- Check if CLI requires interactive login: `myservice login`
- Some CLIs use browser-based OAuth flows
- Ensure the CLI is authenticated before running adapter

### Debug Mode

Enable verbose logging:

```typescript
async provision(context) {
  console.log("[myservice] Starting provisioning...");
  console.log("[myservice] Project path:", context.projectPath);
  
  const result = await exec("myservice", ["create-project"]);
  console.log("[myservice] CLI output:", result.stdout);
  
  return {
    success: true,
    message: "Provisioned successfully",
  };
}
```

## Examples

See these real-world adapters for reference:

- **Stripe** (`src/adapters/stripe-payments.ts`) — Simple API key extraction
- **Supabase** (`src/adapters/supabase-db.ts`) — Project creation and linking
- **Vercel** (`src/adapters/vercel-hosting.ts`) — Repository linking workflow
- **Expo EAS** (`src/adapters/expo-eas.ts`) — Robot account provisioning

## Contributing

To contribute a new adapter to kit:

1. Create adapter file: `src/adapters/your-service.ts`
2. Implement `ServiceAdapter` interface
3. Add tests: `src/adapters/your-service.test.ts`
4. Register in `src/adapters/index.ts`
5. Update this guide with your adapter as an example
6. Submit a pull request

## Questions?

- Open an issue: https://github.com/sandstream/kit/issues
- Check existing adapters for patterns
- Read the TypeScript types for detailed documentation
