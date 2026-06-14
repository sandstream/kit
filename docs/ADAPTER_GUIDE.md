# Custom Service Adapter Guide

This guide explains how to create custom service adapters for the kit CLI.

## Table of Contents

- [Overview](#overview)
- [Adapter Interface](#adapter-interface)
- [Creating Your First Adapter](#creating-your-first-adapter)
- [Best Practices](#best-practices)
- [Testing Your Adapter](#testing-your-adapter)
- [Example Adapters](#example-adapters)
- [Troubleshooting](#troubleshooting)

## Overview

Service adapters enable automated provisioning of external services (APIs, databases, hosting platforms, etc.) without requiring browser-based authentication or manual configuration steps.

### Key Concepts

- **Adapter**: A module that implements the `ServiceAdapter` interface
- **Provisioning**: The process of setting up a service (auth, resource creation, credential extraction)
- **Context**: Project information passed to adapter methods
- **Idempotency**: Adapters should safely handle being called multiple times

### How It Works

1. User runs `kit add <service-name>`
2. kit checks if required CLI tools are installed
3. kit calls adapter's `check()` method
4. If not already provisioned, calls adapter's `provision()` method
5. Secrets written to `.env.local`, metadata to `skills-lock.json`

## Adapter Interface

All adapters must implement the `ServiceAdapter` interface:

```typescript
export interface ServiceAdapter {
  name: string;                    // Unique ID (e.g., "stripe/payments")
  description: string;             // Human-readable description
  check(context: AdapterContext): Promise<boolean>;
  provision(context: AdapterContext): Promise<ProvisionResult>;
  getRequiredTools(): string[];    // Required CLI tools
}
```

### AdapterContext

Provides project information:

```typescript
interface AdapterContext {
  projectName?: string;           // Optional project name
  projectPath: string;            // Absolute path to project
  existingEnv: Record<string, string>; // Current .env.local vars
}
```

### ProvisionResult

Return value from `provision()`:

```typescript
interface ProvisionResult {
  success: boolean;               // Whether provisioning succeeded
  message: string;                // Human-readable result message
  secrets?: Record<string, string>;    // For .env.local
  config?: Record<string, unknown>;    // For skills-lock.json
  error?: string;                 // Error message if failed
}
```

## Creating Your First Adapter

### Step 1: Create Adapter File

Create `src/adapters/my-service.ts`:

```typescript
import { ServiceAdapter, AdapterContext, ProvisionResult } from './types';
import { execSync } from 'child_process';

export const myServiceAdapter: ServiceAdapter = {
  name: 'mycompany/myservice',
  description: 'Provisions MyService API access',
  
  getRequiredTools(): string[] {
    return ['myservice']; // CLI tool name
  },
  
  async check(context: AdapterContext): Promise<boolean> {
    // Check if already provisioned
    // Example: check for API key in environment
    if (context.existingEnv.MYSERVICE_API_KEY) {
      return true;
    }
    
    // Or check CLI auth status
    try {
      execSync('myservice whoami', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  },
  
  async provision(context: AdapterContext): Promise<ProvisionResult> {
    try {
      // Step 1: Verify authentication
      let whoami: string;
      try {
        whoami = execSync('myservice whoami', { encoding: 'utf-8' }).trim();
      } catch {
        return {
          success: false,
          error: 'Not authenticated. Run: myservice login'
        };
      }
      
      // Step 2: Create/configure resources
      const apiKey = execSync('myservice keys create --json', { encoding: 'utf-8' });
      const keyData = JSON.parse(apiKey);
      
      // Step 3: Return secrets and config
      return {
        success: true,
        message: `MyService provisioned for ${whoami}`,
        secrets: {
          MYSERVICE_API_KEY: keyData.key,
          MYSERVICE_PROJECT_ID: keyData.projectId
        },
        config: {
          account: whoami,
          provisionedAt: new Date().toISOString()
        }
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to provision MyService: ${error.message}`
      };
    }
  }
};
```

### Step 2: Register Adapter

Add to `src/adapters/index.ts`:

```typescript
import { myServiceAdapter } from './my-service';

export const adapters: AdapterRegistry = {
  'stripe/payments': stripePaymentsAdapter,
  'supabase/db': supabaseDbAdapter,
  'mycompany/myservice': myServiceAdapter, // Add here
  // ...
};
```

### Step 3: Test

```bash
# Install the CLI tool first
mise install myservice@latest

# Test your adapter
npm run dev add mycompany/myservice
```

## Best Practices

### 1. Idempotency

Adapters should be safe to run multiple times:

```typescript
async check(context: AdapterContext): Promise<boolean> {
  // Check multiple conditions
  const hasEnvVars = !!context.existingEnv.MY_API_KEY;
  const configExists = fs.existsSync(path.join(context.projectPath, '.myservice'));
  
  return hasEnvVars && configExists;
}
```

### 2. Error Handling

Provide actionable error messages:

```typescript
async provision(context: AdapterContext): Promise<ProvisionResult> {
  try {
    execSync('myservice whoami', { stdio: 'ignore' });
  } catch {
    return {
      success: false,
      error: 'Not authenticated. Run:\n  myservice login\n  kit add mycompany/myservice'
    };
  }
  // ...
}
```

### 3. CLI Output Parsing

Be careful with CLI output formats:

```typescript
// ✅ Good: Use JSON output when available
const output = execSync('myservice keys list --json', { encoding: 'utf-8' });
const keys = JSON.parse(output);

// ❌ Avoid: Parsing human-readable text
const output = execSync('myservice keys list', { encoding: 'utf-8' });
const key = output.match(/Key: (\w+)/)?.[1]; // Fragile!
```

### 4. Minimal Privileges

Request minimal necessary credentials:

```typescript
// ✅ Good: Request read-only token if possible
secrets: {
  MYSERVICE_READ_TOKEN: readToken
}

// ❌ Avoid: Requesting admin tokens unnecessarily
secrets: {
  MYSERVICE_ADMIN_TOKEN: adminToken
}
```

### 5. Local Development Support

Prefer local development environments:

```typescript
// ✅ Good: Support local dev mode
const isLocal = process.env.NODE_ENV === 'development';
secrets: {
  MYSERVICE_URL: isLocal ? 'http://localhost:8080' : 'https://api.myservice.com',
  MYSERVICE_API_KEY: apiKey
}
```

## Testing Your Adapter

### Manual Testing

```bash
# 1. Install CLI tool
mise install myservice@latest

# 2. Run adapter
npm run dev add mycompany/myservice

# 3. Verify secrets in .env.local
cat .env.local | grep MYSERVICE

# 4. Verify metadata in skills-lock.json
cat .kit/skills-lock.json | jq '.provisioned["mycompany/myservice"]'
```

### Automated Testing

Create `src/adapters/my-service.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { myServiceAdapter } from './my-service';

describe('myServiceAdapter', () => {
  it('should have correct metadata', () => {
    expect(myServiceAdapter.name).toBe('mycompany/myservice');
    expect(myServiceAdapter.description).toBeTruthy();
  });
  
  it('should require myservice CLI', () => {
    const tools = myServiceAdapter.getRequiredTools();
    expect(tools).toContain('myservice');
  });
  
  it('should check for existing API key', async () => {
    const context = {
      projectPath: '/tmp/test',
      existingEnv: { MYSERVICE_API_KEY: 'test-key' }
    };
    
    const result = await myServiceAdapter.check(context);
    expect(result).toBe(true);
  });
  
  // Add more tests...
});
```

Run tests:

```bash
npm test src/adapters/my-service.test.ts
```

## Example Adapters

### Simple Adapter (API Token Only)

```typescript
export const simpleAdapter: ServiceAdapter = {
  name: 'simple/service',
  description: 'Simple token-based service',
  
  getRequiredTools: () => ['simple-cli'],
  
  async check(ctx) {
    return !!ctx.existingEnv.SIMPLE_TOKEN;
  },
  
  async provision(ctx) {
    const token = execSync('simple-cli token create', { encoding: 'utf-8' }).trim();
    return {
      success: true,
      message: 'Token created',
      secrets: { SIMPLE_TOKEN: token }
    };
  }
};
```

### Complex Adapter (Multi-Step Setup)

```typescript
export const complexAdapter: ServiceAdapter = {
  name: 'complex/service',
  description: 'Service with multi-step provisioning',
  
  getRequiredTools: () => ['complex-cli', 'docker'],
  
  async check(ctx) {
    // Check multiple conditions
    const hasToken = !!ctx.existingEnv.COMPLEX_TOKEN;
    const containerRunning = execSync('docker ps --filter name=complex --format "{{.Names}}"', 
      { encoding: 'utf-8' }).includes('complex');
    return hasToken && containerRunning;
  },
  
  async provision(ctx) {
    // Step 1: Authenticate
    try {
      execSync('complex-cli whoami', { stdio: 'ignore' });
    } catch {
      return {
        success: false,
        error: 'Not authenticated. Run: complex-cli login'
      };
    }
    
    // Step 2: Start local container
    execSync(`docker run -d --name complex-dev -p 5432:5432 complex/dev`, { stdio: 'inherit' });
    
    // Step 3: Create project
    const projectJson = execSync('complex-cli projects create --json', { encoding: 'utf-8' });
    const project = JSON.parse(projectJson);
    
    // Step 4: Generate token
    const token = execSync(`complex-cli tokens create --project ${project.id}`, 
      { encoding: 'utf-8' }).trim();
    
    return {
      success: true,
      message: `Complex service provisioned (project: ${project.name})`,
      secrets: {
        COMPLEX_TOKEN: token,
        COMPLEX_PROJECT_ID: project.id,
        COMPLEX_URL: 'http://localhost:5432'
      },
      config: {
        projectName: project.name,
        containerName: 'complex-dev'
      }
    };
  }
};
```

### Docker-Based Service

```typescript
export const dockerAdapter: ServiceAdapter = {
  name: 'docker/service',
  description: 'Self-hosted service via Docker',
  
  getRequiredTools: () => ['docker'],
  
  async check(ctx) {
    try {
      const containers = execSync('docker ps --filter name=myservice --format "{{.Names}}"', 
        { encoding: 'utf-8' });
      return containers.includes('myservice');
    } catch {
      return false;
    }
  },
  
  async provision(ctx) {
    const containerName = 'myservice-dev';
    
    // Check if container exists but is stopped
    try {
      const existingContainer = execSync(
        `docker ps -a --filter name=${containerName} --format "{{.Names}}"`,
        { encoding: 'utf-8' }
      ).trim();
      
      if (existingContainer === containerName) {
        execSync(`docker start ${containerName}`, { stdio: 'inherit' });
        return {
          success: true,
          message: 'Existing container restarted',
          secrets: { MYSERVICE_URL: 'http://localhost:8080' }
        };
      }
    } catch {
      // Container doesn't exist, create it
    }
    
    // Create and start container
    execSync(
      `docker run -d --name ${containerName} -p 8080:8080 myservice/image:latest`,
      { stdio: 'inherit' }
    );
    
    // Wait for health check
    let healthy = false;
    for (let i = 0; i < 30; i++) {
      try {
        const response = await fetch('http://localhost:8080/health');
        if (response.ok) {
          healthy = true;
          break;
        }
      } catch {
        // Wait and retry
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    if (!healthy) {
      return {
        success: false,
        error: 'Container started but failed health check'
      };
    }
    
    return {
      success: true,
      message: 'Docker container started',
      secrets: { MYSERVICE_URL: 'http://localhost:8080' },
      config: { containerName }
    };
  }
};
```

## Troubleshooting

### Common Issues

#### 1. "Tool not found" Error

**Problem**: CLI tool not installed

**Solution**: 
```bash
# Install via mise
mise install <tool>@latest

# Or add to .mise.toml
[tools]
mytool = "latest"
```

#### 2. "Not authenticated" Error

**Problem**: CLI tool not logged in

**Solution**:
```bash
# Login to service
mytool login

# Or set token directly
export MYTOOL_TOKEN="your-token"
```

#### 3. Secrets Not Appearing in .env.local

**Problem**: `provision()` not returning secrets

**Check**:
- Ensure `secrets` object is returned in `ProvisionResult`
- Verify secret values are non-empty strings
- Check file permissions on `.env.local`

#### 4. Adapter Runs Every Time

**Problem**: `check()` method always returns false

**Fix**:
```typescript
async check(ctx: AdapterContext): Promise<boolean> {
  // Add debug logging
  console.log('Checking env:', ctx.existingEnv);
  
  // Verify secret key names match exactly
  return !!ctx.existingEnv.MY_API_KEY; // Must match secrets key
}
```

#### 5. CLI Command Hangs

**Problem**: CLI tool waiting for interactive input

**Solution**:
```typescript
// ✅ Use non-interactive flags
execSync('mytool create --yes --json', options);

// ❌ Avoid interactive commands
execSync('mytool create', options); // May prompt user
```

### Debug Mode

Enable debug output:

```bash
DEBUG=kit:* npm run dev add mycompany/myservice
```

View provisioning logs:

```bash
cat .kit/provision.log
```

### Getting Help

1. Check existing adapters in `src/adapters/` for examples
2. Review type definitions in `src/adapters/types.ts`
3. Run tests: `npm test src/adapters/`
4. Open an issue on GitHub with adapter code and error output

## Next Steps

- Review [existing adapters](../src/adapters/) for real-world examples
- Read the [main README](../README.md) for usage examples
- Check [provision.ts](../src/provision.ts) to understand the provisioning flow
- Contribute your adapter back to the project!
