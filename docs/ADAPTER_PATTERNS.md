# Advanced Adapter Patterns

This guide covers sophisticated patterns for building complex kit adapters that handle multi-service provisioning, dependency management, and advanced scenarios.

## Pattern 1: Composite Adapters (Adapter Dependencies)

When one service depends on another being provisioned first.

### Use Case: Supabase (requires PostgreSQL)

```typescript
import type { ServiceAdapter, AdapterContext, ProvisionResult } from "sandstream-kit-adapter-sdk";

/**
 * Composite adapter: Supabase depends on its own database
 * This adapter handles the multi-step provisioning of Supabase + PostgreSQL
 */
export const supabaseCompositeAdapter: ServiceAdapter = {
  name: "supabase/platform",
  description: "PostgreSQL + Supabase backend",
  
  getRequiredTools(): string[] {
    return []; // API-based
  },
  
  async check(context: AdapterContext): Promise<boolean> {
    // Check all required credentials are present
    return !!(
      context.existingEnv["SUPABASE_URL"] &&
      context.existingEnv["SUPABASE_KEY"] &&
      context.existingEnv["DATABASE_URL"]
    );
  },
  
  async provision(context: AdapterContext): Promise<ProvisionResult> {
    const existingUrl = context.existingEnv["SUPABASE_URL"];
    const existingKey = context.existingEnv["SUPABASE_KEY"];
    const existingDb = context.existingEnv["DATABASE_URL"];
    
    // Full composite: all pieces already configured
    if (existingUrl && existingKey && existingDb) {
      return {
        success: true,
        message: "Supabase platform fully configured",
        secrets: {
          SUPABASE_URL: existingUrl,
          SUPABASE_KEY: existingKey,
          DATABASE_URL: existingDb,
        },
      };
    }
    
    // Partial: Some pieces exist, others don't
    const results: Record<string, string> = {};
    const missing: string[] = [];
    
    if (existingUrl) results["SUPABASE_URL"] = existingUrl;
    else missing.push("SUPABASE_URL");
    
    if (existingKey) results["SUPABASE_KEY"] = existingKey;
    else missing.push("SUPABASE_KEY");
    
    if (existingDb) results["DATABASE_URL"] = existingDb;
    else missing.push("DATABASE_URL");
    
    // Return what we have, but flag missing pieces
    if (missing.length > 0) {
      return {
        success: false,
        error: "incomplete_configuration",
        message: `Set up Supabase platform:\n\nMissing: ${missing.join(", ")}\n\n1. Visit https://supabase.com\n2. Create a project\n3. Copy credentials from Settings > API\n4. Add to .env.local`,
        secrets: results,
      };
    }
    
    return {
      success: true,
      message: "Supabase platform ready",
      secrets: results,
    };
  },
};
```

## Pattern 2: Multi-Service Adapters

Handle multiple related services in a single adapter.

### Use Case: Stripe (payments + webhooks + accounts)

```typescript
export const stripeMultiServiceAdapter: ServiceAdapter = {
  name: "stripe/complete",
  description: "Stripe payments, webhooks, and billing",
  
  getRequiredTools(): string[] {
    return []; // API-based
  },
  
  async check(context: AdapterContext): Promise<boolean> {
    // Need secret key + publishable key for full setup
    return !!(
      context.existingEnv["STRIPE_SECRET_KEY"] &&
      context.existingEnv["STRIPE_PUBLISHABLE_KEY"]
    );
  },
  
  async provision(context: AdapterContext): Promise<ProvisionResult> {
    const secretKey = context.existingEnv["STRIPE_SECRET_KEY"];
    const publishableKey = context.existingEnv["STRIPE_PUBLISHABLE_KEY"];
    
    if (secretKey && publishableKey) {
      return {
        success: true,
        message: "Stripe fully configured",
        secrets: {
          STRIPE_SECRET_KEY: secretKey,
          STRIPE_PUBLISHABLE_KEY: publishableKey,
          STRIPE_WEBHOOK_SECRET: context.existingEnv["STRIPE_WEBHOOK_SECRET"] || "",
        },
      };
    }
    
    const instructions = [
      "Configure Stripe for payments and webhooks:",
      "",
      "1. Go to https://dashboard.stripe.com/apikeys",
      "2. Copy Secret Key → STRIPE_SECRET_KEY",
      "3. Copy Publishable Key → STRIPE_PUBLISHABLE_KEY",
      "4. Set up webhooks: https://dashboard.stripe.com/webhooks",
      "5. Copy Webhook Signing Secret → STRIPE_WEBHOOK_SECRET",
    ].join("\n");
    
    return {
      success: false,
      error: "missing_stripe_credentials",
      message: instructions,
      secrets: {
        STRIPE_SECRET_KEY: secretKey || "",
        STRIPE_PUBLISHABLE_KEY: publishableKey || "",
      },
    };
  },
};
```

## Pattern 3: Environment-Aware Adapters

Different behavior for dev, staging, and production.

### Use Case: Database (local vs. cloud)

```typescript
export const adaptiveDbAdapter: ServiceAdapter = {
  name: "database/adaptive",
  description: "SQLite for dev, PostgreSQL for production",
  
  getRequiredTools(): string[] {
    return [];
  },
  
  async check(context: AdapterContext): Promise<boolean> {
    // Check environment-appropriate database
    const isProd = context.existingEnv["NODE_ENV"] === "production";
    
    if (isProd) {
      // Production: need cloud database
      return !!context.existingEnv["DATABASE_URL"];
    } else {
      // Development: SQLite is fine
      return true; // SQLite can be used by default
    }
  },
  
  async provision(context: AdapterContext): Promise<ProvisionResult> {
    const env = context.existingEnv["NODE_ENV"] || "development";
    const existingUrl = context.existingEnv["DATABASE_URL"];
    
    if (env === "production") {
      if (existingUrl) {
        return {
          success: true,
          message: `Using cloud database: ${existingUrl.split("@")[1]}`,
          secrets: {
            DATABASE_URL: existingUrl,
            DATABASE_TYPE: "postgresql",
          },
        };
      }
      
      return {
        success: false,
        error: "production_needs_database",
        message: "Production requires a cloud database. Set DATABASE_URL",
      };
    }
    
    // Development: use SQLite by default
    return {
      success: true,
      message: "Using SQLite for development (${project_dir}/dev.sqlite)",
      secrets: {
        DATABASE_URL: "sqlite:dev.sqlite",
        DATABASE_TYPE: "sqlite",
      },
    };
  },
};
```

## Pattern 4: Conditional Provisioning

Adapters that work differently based on other configured services.

### Use Case: Webhooks (only if using cloud service)

```typescript
export const webhooksAdapter: ServiceAdapter = {
  name: "webhooks/conditional",
  description: "Webhooks for external services",
  
  getRequiredTools(): string[] {
    return [];
  },
  
  async check(context: AdapterContext): Promise<boolean> {
    // Only needed if using cloud services
    const hasStripe = !!context.existingEnv["STRIPE_WEBHOOK_SECRET"];
    const hasGithub = !!context.existingEnv["GITHUB_WEBHOOK_SECRET"];
    
    return hasStripe || hasGithub;
  },
  
  async provision(context: AdapterContext): Promise<ProvisionResult> {
    const webhooks: Record<string, string> = {};
    const missing: string[] = [];
    
    // Stripe webhooks (if Stripe is configured)
    if (context.existingEnv["STRIPE_SECRET_KEY"]) {
      const stripeSecret = context.existingEnv["STRIPE_WEBHOOK_SECRET"];
      if (stripeSecret) {
        webhooks["STRIPE_WEBHOOK_SECRET"] = stripeSecret;
      } else {
        missing.push("Stripe webhook secret");
      }
    }
    
    // GitHub webhooks (if GitHub is configured)
    if (context.existingEnv["GITHUB_TOKEN"]) {
      const githubSecret = context.existingEnv["GITHUB_WEBHOOK_SECRET"];
      if (githubSecret) {
        webhooks["GITHUB_WEBHOOK_SECRET"] = githubSecret;
      } else {
        missing.push("GitHub webhook secret");
      }
    }
    
    if (Object.keys(webhooks).length === 0 && missing.length === 0) {
      return {
        success: true,
        message: "No external services configured for webhooks",
        secrets: {},
      };
    }
    
    if (missing.length > 0) {
      return {
        success: false,
        error: "incomplete_webhook_setup",
        message: `Set up webhook secrets:\n${missing.map(m => `- ${m}`).join("\n")}`,
        secrets: webhooks,
      };
    }
    
    return {
      success: true,
      message: "Webhooks configured",
      secrets: webhooks,
    };
  },
};
```

## Pattern 5: Async/Long-Running Operations

Handle provisioning that takes time.

### Use Case: Database Provisioning

```typescript
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export const asyncProvisioningAdapter: ServiceAdapter = {
  name: "database/async",
  description: "Database with async provisioning",
  
  getRequiredTools(): string[] {
    return ["terraform", "aws-cli"];
  },
  
  async check(context: AdapterContext): Promise<boolean> {
    const dbUrl = context.existingEnv["DATABASE_URL"];
    if (!dbUrl) return false;
    
    // Verify database is actually accessible
    try {
      // Try a ping/health check
      await exec("pg_isready", ["-h", extractHost(dbUrl)], {
        timeout: 5000,
      });
      return true;
    } catch {
      return false;
    }
  },
  
  async provision(context: AdapterContext): Promise<ProvisionResult> {
    const existingUrl = context.existingEnv["DATABASE_URL"];
    
    if (existingUrl) {
      return {
        success: true,
        message: "Database already configured",
        secrets: { DATABASE_URL: existingUrl },
      };
    }
    
    // Long-running: provision database cluster
    try {
      console.log("Provisioning database cluster... (this may take 5-10 minutes)");
      
      const { stdout } = await exec("terraform", ["apply", "-auto-approve"], {
        timeout: 600_000, // 10 minutes
      });
      
      // Extract URL from terraform output
      const urlMatch = stdout.match(/database_url = "(.*)"/);
      const dbUrl = urlMatch?.[1] || "";
      
      if (!dbUrl) {
        throw new Error("Could not extract database URL from terraform");
      }
      
      return {
        success: true,
        message: "Database provisioned and ready",
        secrets: { DATABASE_URL: dbUrl },
        config: {
          provisioned_at: new Date().toISOString(),
          method: "terraform",
        },
      };
    } catch (err: unknown) {
      const error = err as { message?: string };
      return {
        success: false,
        error: "provisioning_failed",
        message: `Database provisioning failed: ${error.message}`,
      };
    }
  },
};

function extractHost(dbUrl: string): string {
  try {
    const url = new URL(dbUrl);
    return url.hostname;
  } catch {
    return "localhost";
  }
}
```

## Pattern 6: Configuration Validation

Validate and transform configuration.

### Use Case: Complex Configuration

```typescript
export const validatingAdapter: ServiceAdapter = {
  name: "config/validated",
  description: "Configuration with validation",
  
  getRequiredTools(): string[] {
    return [];
  },
  
  async check(context: AdapterContext): Promise<boolean> {
    const config = context.existingEnv["APP_CONFIG"];
    return config !== undefined && isValidConfig(config);
  },
  
  async provision(context: AdapterContext): Promise<ProvisionResult> {
    const rawConfig = context.existingEnv["APP_CONFIG"];
    
    if (!rawConfig) {
      return {
        success: false,
        error: "missing_config",
        message: "Set APP_CONFIG in .env.local",
      };
    }
    
    // Validate and transform
    try {
      const parsed = JSON.parse(rawConfig);
      const validated = validateAndTransform(parsed);
      
      return {
        success: true,
        message: "Configuration validated",
        secrets: {
          APP_CONFIG: JSON.stringify(validated),
          APP_CONFIG_HASH: hashConfig(validated),
        },
        config: {
          validated_at: new Date().toISOString(),
          version: validated.version,
        },
      };
    } catch (err: unknown) {
      const error = err as Error;
      return {
        success: false,
        error: "invalid_config",
        message: `Configuration validation failed: ${error.message}`,
      };
    }
  },
};

function isValidConfig(config: string): boolean {
  try {
    const parsed = JSON.parse(config);
    return validateAndTransform(parsed) !== null;
  } catch {
    return false;
  }
}

function validateAndTransform(config: unknown): unknown {
  if (!config || typeof config !== "object") {
    throw new Error("Config must be an object");
  }
  
  // Add validation logic here
  return config;
}

function hashConfig(config: unknown): string {
  return require("crypto")
    .createHash("sha256")
    .update(JSON.stringify(config))
    .digest("hex");
}
```

## Pattern 7: Error Recovery & Retry

Handle transient failures gracefully.

```typescript
export const resilientAdapter: ServiceAdapter = {
  name: "service/resilient",
  description: "Adapter with retry logic",
  
  getRequiredTools(): string[] {
    return [];
  },
  
  async check(context: AdapterContext): Promise<boolean> {
    return await checkWithRetry(context, 3, 1000);
  },
  
  async provision(context: AdapterContext): Promise<ProvisionResult> {
    return await provisionWithRetry(context, 3, 1000);
  },
};

async function checkWithRetry(
  context: AdapterContext,
  maxRetries: number,
  delayMs: number
): Promise<boolean> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      // Your check logic here
      return !!context.existingEnv["SERVICE_KEY"];
    } catch (err) {
      if (i === maxRetries - 1) throw err;
      await new Promise((resolve) => setTimeout(resolve, delayMs * (i + 1)));
    }
  }
  return false;
}

async function provisionWithRetry(
  context: AdapterContext,
  maxRetries: number,
  delayMs: number
): Promise<ProvisionResult> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      // Your provisioning logic here
      return {
        success: true,
        message: "Provisioned",
        secrets: {},
      };
    } catch (err: unknown) {
      const error = err as { message?: string };
      if (i === maxRetries - 1) {
        return {
          success: false,
          error: "provisioning_failed",
          message: `Failed after ${maxRetries} retries: ${error.message}`,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs * (i + 1)));
    }
  }
  
  return {
    success: false,
    error: "unknown",
    message: "Provisioning failed",
  };
}
```

## Best Practices for Complex Adapters

### ✅ DO

- **Compose Small Adapters**: Create single-purpose adapters and compose them
- **Validate Early**: Check all prerequisites before starting long operations
- **Provide Clear Errors**: Include URLs and setup instructions
- **Handle Partial State**: Support incomplete configurations gracefully
- **Use Timeouts**: Set reasonable timeouts for CLI/API operations
- **Document Dependencies**: Clearly state what other adapters are needed
- **Test Edge Cases**: Test missing CLIs, invalid configs, network failures

### ❌ DON'T

- **Create God Adapters**: Keep adapters focused on one service
- **Ignore Errors**: Handle all failure paths
- **Hardcode Secrets**: Never embed API keys in code
- **Block on External Services**: Use async operations for slow provisioning
- **Assume Tools Exist**: Always check getRequiredTools() requirements
- **Lose Existing Config**: Implement key-reuse pattern

## Testing Complex Adapters

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("Complex Adapter", () => {
  // Test partial state
  it("handles partially configured services", async () => {
    const ctx = {
      projectPath: "/tmp/test",
      existingEnv: { SERVICE_KEY: "abc" }, // Missing SERVICE_SECRET
    };
    
    const result = await adapter.provision(ctx);
    assert.equal(result.success, false);
    assert.equal(result.secrets?.SERVICE_KEY, "abc"); // Returns what exists
    assert.ok(result.error);
  });
  
  // Test dependencies
  it("requires dependent service to be configured", async () => {
    const ctx = {
      projectPath: "/tmp/test",
      existingEnv: {}, // No dependency
    };
    
    const result = await adapter.provision(ctx);
    assert.equal(result.success, false);
    assert.match(result.message, /dependency|requires/i);
  });
  
  // Test error recovery
  it("handles transient failures", async () => {
    let attempts = 0;
    // Mock API that fails first time
    const ctx = {
      projectPath: "/tmp/test",
      existingEnv: { SIMULATE_FAILURE: "1" },
    };
    
    const result = await adapter.provision(ctx);
    // Should succeed after retry
    assert.equal(result.success, true);
  });
});
```

## When to Use Each Pattern

| Pattern | Use Case |
|---------|----------|
| **Composite** | One service depends on another (Supabase + DB) |
| **Multi-Service** | Related services managed together (Stripe + webhooks) |
| **Environment-Aware** | Different setup per environment (dev SQLite, prod PostgreSQL) |
| **Conditional** | Only provisions if other services exist (webhooks) |
| **Async Operations** | Long-running provisioning (database clusters) |
| **Configuration** | Complex validation and transformation |
| **Error Recovery** | Transient failures and retries |

## References

- [ServiceAdapter Interface](/packages/adapter-sdk/src/index.ts)
- [Plugin Development Guide](/docs/PLUGIN_DEVELOPMENT.md)
- [Official Adapters](/src/adapters)
