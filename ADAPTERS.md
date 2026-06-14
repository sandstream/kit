# Service Provisioning Adapters

kit includes a service provisioning system that allows automated setup of external services via CLI/API — no browser required. This guide explains how to create custom adapters.

## Overview

Service adapters enable the `kit add <service>` command to provision services automatically. Each adapter:

1. Checks if required CLI tools are installed
2. Authenticates with the service (if needed)
3. Creates/configures resources (projects, API keys, etc.)
4. Extracts credentials and writes them to `.env.local`
5. Records provisioning metadata in `skills-lock.json`

## Adapter Interface

All adapters implement the `ServiceAdapter` interface:

```typescript
interface ServiceAdapter {
  name: string;
  description: string;
  check(context: AdapterContext): Promise<boolean>;
  provision(context: AdapterContext): Promise<ProvisionResult>;
  getRequiredTools(): string[];
}
```

### Methods

#### `getRequiredTools()`

Returns an array of CLI tool names that must be installed. kit will verify these before calling `provision()`.

```typescript
getRequiredTools(): string[] {
  return ["stripe"];  // Will check: stripe --version
}
```

#### `check(context)`

Checks if the service is already provisioned. Return `true` to skip provisioning.

Common checks:
- Environment variables exist
- CLI is authenticated
- Resources already exist

```typescript
async check(context: AdapterContext): Promise<boolean> {
  // Check if we already have API keys
  if (context.existingEnv.STRIPE_SECRET_KEY) {
    return true;
  }
  
  // Check if CLI is authenticated
  try {
    await exec("stripe", ["config", "--list"]);
    return true;
  } catch {
    return false;
  }
}
```

#### `provision(context)`

Performs the actual provisioning. Should be idempotent where possible.

```typescript
async provision(context: AdapterContext): Promise<ProvisionResult> {
  try {
    // 1. Authenticate (if needed)
    await exec("stripe", ["login"]);
    
    // 2. Create resources
    const { stdout } = await exec("stripe", ["keys", "create", "--name", context.projectName]);
    const apiKey = parseApiKey(stdout);
    
    // 3. Return credentials
    return {
      success: true,
      message: "Stripe configured with API keys",
      secrets: {
        STRIPE_SECRET_KEY: apiKey.secret,
        STRIPE_PUBLISHABLE_KEY: apiKey.publishable,
      },
      config: {
        accountId: apiKey.accountId,
        environment: "development",
      },
    };
  } catch (error) {
    return {
      success: false,
      message: "Failed to provision Stripe",
      error: error.message,
    };
  }
}
```

## Creating a Custom Adapter

### Step 1: Create the Adapter File

Create a new file in `src/adapters/` following the pattern `<provider>-<service>.ts`:

```typescript
// src/adapters/sendgrid-email.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ServiceAdapter, AdapterContext, ProvisionResult } from "./types.js";

const exec = promisify(execFile);

export const sendgridEmailAdapter: ServiceAdapter = {
  name: "sendgrid/email",
  description: "Email delivery with SendGrid",
  
  getRequiredTools(): string[] {
    return ["sendgrid"];
  },
  
  async check(context: AdapterContext): Promise<boolean> {
    // Check if API key already exists
    if (context.existingEnv.SENDGRID_API_KEY) {
      return true;
    }
    return false;
  },
  
  async provision(context: AdapterContext): Promise<ProvisionResult> {
    try {
      // Check if already authenticated
      try {
        await exec("sendgrid", ["api", "user.profile", "--get"]);
      } catch {
        return {
          success: false,
          message: "Please authenticate with SendGrid first",
          error: "Run: sendgrid login",
        };
      }
      
      // Create API key
      const keyName = `kit-${context.projectName || "project"}-${Date.now()}`;
      const { stdout } = await exec("sendgrid", [
        "api",
        "api_keys.post",
        "--data",
        JSON.stringify({ name: keyName, scopes: ["mail.send"] }),
      ]);
      
      const result = JSON.parse(stdout);
      
      return {
        success: true,
        message: "SendGrid configured with API key",
        secrets: {
          SENDGRID_API_KEY: result.api_key,
        },
        config: {
          keyId: result.api_key_id,
          createdAt: new Date().toISOString(),
        },
      };
    } catch (error) {
      return {
        success: false,
        message: "Failed to provision SendGrid",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
};
```

### Step 2: Register the Adapter

Add your adapter to `src/adapters/index.ts`:

```typescript
import { sendgridEmailAdapter } from "./sendgrid-email.js";

export const adapters: AdapterRegistry = {
  "stripe/payments": stripePaymentsAdapter,
  "supabase/db": supabaseDbAdapter,
  "vercel/hosting": vercelHostingAdapter,
  "sendgrid/email": sendgridEmailAdapter,  // <-- Add this
};
```

### Step 3: Test the Adapter

```bash
# Build
pnpm build

# Test provisioning
kit add sendgrid/email

# Verify secrets were written
cat .env.local | grep SENDGRID

# Check provisioning metadata
cat skills-lock.json | jq '.provisioned'
```

## Best Practices

### 1. Idempotency

Design adapters to be safe to run multiple times:

```typescript
async check(context: AdapterContext): Promise<boolean> {
  // Check multiple conditions
  const hasEnvVars = !!context.existingEnv.SERVICE_API_KEY;
  const hasConfig = await checkSkillsLock(context.projectPath, this.name);
  
  return hasEnvVars && hasConfig;
}
```

### 2. Error Handling

Provide clear error messages and recovery instructions:

```typescript
try {
  // Attempt provisioning
} catch (error) {
  return {
    success: false,
    message: "Authentication failed",
    error: "Run 'service-cli login' and try again",
  };
}
```

### 3. Non-Interactive Authentication

Where possible, use CLI authentication flows that don't require a browser:

```typescript
// Good: CLI-based auth
await exec("service-cli", ["login", "--token", token]);

// Avoid: Browser-based OAuth (blocks agent workflows)
await exec("service-cli", ["login"]);  // Opens browser
```

### 4. Secret Security

- Never log secrets to console
- Use secure methods to extract credentials
- Validate secrets before writing to `.env.local`

```typescript
// Extract and validate
const apiKey = extractApiKey(stdout);
if (!apiKey || apiKey.length < 32) {
  throw new Error("Invalid API key format");
}

// Write to secrets (not config)
return {
  secrets: { API_KEY: apiKey },  // ✓ Goes to .env.local
  config: { keyId: "sk_123" },   // ✓ Goes to skills-lock.json
};
```

### 5. Graceful Degradation

Handle missing tools and authentication gracefully:

```typescript
async provision(context: AdapterContext): Promise<ProvisionResult> {
  // Check authentication
  try {
    await exec("cli", ["whoami"]);
  } catch {
    return {
      success: false,
      message: "Not authenticated",
      error: "Run 'cli login' first, then try 'kit add service' again",
    };
  }
  
  // Continue provisioning...
}
```

## Examples

See existing adapters for reference implementations:

- **Stripe Payments** (`src/adapters/stripe-payments.ts`)
  - CLI authentication check
  - API key creation
  - Test mode configuration

- **Supabase Database** (`src/adapters/supabase-db.ts`)
  - Local development setup
  - Remote project linking
  - Multiple secret extraction

- **Vercel Hosting** (`src/adapters/vercel-hosting.ts`)
  - Repository linking
  - Project configuration
  - Environment variable detection

- **Expo EAS** (`src/adapters/expo-eas.ts`)
  - Mobile app provisioning
  - Build configuration
  - Complex secret structures

## Troubleshooting

### Adapter not found

```bash
$ kit add my-service
Error: Unknown service: my-service
```

**Solution**: Register adapter in `src/adapters/index.ts`

### Required tool not installed

```bash
$ kit add stripe/payments
Error: Required tool not installed: stripe
```

**Solution**: Install the CLI tool:
```bash
brew install stripe/stripe-cli/stripe
```

### Authentication required

```bash
$ kit add stripe/payments
Error: Not authenticated
```

**Solution**: Authenticate with the service first:
```bash
stripe login
kit add stripe/payments
```

### Secrets not written

Check that your adapter returns secrets in the correct format:

```typescript
return {
  success: true,
  message: "...",
  secrets: {  // Must be Record<string, string>
    KEY_NAME: "value",
  },
};
```

## Contributing

To contribute a new adapter:

1. Create adapter file in `src/adapters/`
2. Implement `ServiceAdapter` interface
3. Add JSDoc comments
4. Register in `src/adapters/index.ts`
5. Add tests
6. Update this documentation
7. Submit PR

For questions, see the [kit repository](https://github.com/sandstream/kit).
