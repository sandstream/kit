# Plugin Documentation Standards

This document defines the documentation structure and content standards for all kit plugins. Following these standards ensures plugins are discoverable, understandable, and professional.

## Document Structure

Every plugin package should include:

```
plugin-root/
├── README.md              # Main overview (required)
├── docs/
│   ├── API.md            # ServiceAdapter interface docs
│   ├── CONFIGURATION.md  # Environment variables & setup
│   ├── EXAMPLES.md       # Usage examples
│   ├── TESTING.md        # Testing guide
│   └── TROUBLESHOOTING.md # Common issues
├── CHANGELOG.md          # Version history
├── package.json          # Metadata
└── plugin.json           # Registry metadata (optional)
```

## 1. README.md (Required)

The README is the primary entry point. It should be concise but comprehensive.

### Structure

```markdown
# Plugin Name

> One-line description

## Overview

2-3 paragraph overview of what this plugin does and when to use it.

### When to Use
- Use case 1
- Use case 2
- NOT suitable for [counter-case]

## Quick Start

```bash
kit plugin install package/name
```

### Minimal Setup

Show the absolute minimum to get working:

```typescript
export const myAdapter: ServiceAdapter = {
  name: "provider/service",
  description: "...",
  // ...
};
```

## Features

- Feature 1: Description
- Feature 2: Description
- Feature 3: Description

## Installation

```bash
# Via kit
kit plugin install provider/service

# Via npm
npm install @provider/kit-service
```

## Configuration

Set required environment variables:

```env
SERVICE_API_KEY=your_key_here
SERVICE_WEBHOOK_SECRET=webhook_secret
```

See [CONFIGURATION.md](./docs/CONFIGURATION.md) for details.

## Usage Examples

### Basic Example

```typescript
// Using the adapter
const context = {
  projectPath: "/path/to/project",
  existingEnv: process.env,
};

const result = await adapter.provision(context);
if (result.success) {
  console.log("Configured:", result.secrets);
}
```

See [EXAMPLES.md](./docs/EXAMPLES.md) for more.

## API Reference

- `name`: string - Unique identifier (provider/service format)
- `check()` - Verify if already provisioned
- `provision()` - Perform provisioning
- `getRequiredTools()` - List required CLI tools

Full API documentation: [API.md](./docs/API.md)

## Testing

```bash
npm test
```

All tests should pass. See [TESTING.md](./docs/TESTING.md) for testing guidelines.

## Troubleshooting

Common issues and solutions: [TROUBLESHOOTING.md](./docs/TROUBLESHOOTING.md)

## Support

- GitHub Issues: [provider/kit-service/issues](https://github.com/provider/kit-service/issues)
- Documentation: [Full Docs](./docs)
- kit Plugin Guide: [Plugin Development](../PLUGIN_DEVELOPMENT.md)

## License

MIT (or your chosen license)

## Version

Current version: 1.0.0

See [CHANGELOG.md](./CHANGELOG.md) for version history.
```

## 2. docs/API.md

Full API documentation for the ServiceAdapter interface.

```markdown
# API Reference

## ServiceAdapter Interface

All kit plugins implement the `ServiceAdapter` interface.

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

## 3. docs/CONFIGURATION.md

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

## 4. docs/EXAMPLES.md

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

```toml
# .kit.toml
[adapters]
payment = "stripe/payments"
database = "supabase/database"
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

## 5. docs/TESTING.md

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

## 6. CHANGELOG.md

Version history and breaking changes.

```markdown
# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-04-15

### Added
- Initial release
- ServiceAdapter implementation for Service Name
- Support for API key authentication
- Webhook signature validation
- Complete test suite (10 tests, 100% pass)

### Changed
- Breaking: Renamed SERVICE_TOKEN to SERVICE_API_KEY
- Updated to sandstream-kit-adapter-sdk 0.1.0

### Fixed
- Incorrect timeout values in retry logic

### Deprecated
- SERVICE_TOKEN environment variable (use SERVICE_API_KEY)

## [0.1.0] - 2026-04-01

### Added
- Beta release for testing
- Basic adapter structure

---

## Version Format

Use [Semantic Versioning](https://semver.org/):
- MAJOR: Breaking changes (0.1.0 → 1.0.0)
- MINOR: New features (1.0.0 → 1.1.0)
- PATCH: Bug fixes (1.0.0 → 1.0.1)

## Commit Message Standards

- `feat:` New feature
- `fix:` Bug fix
- `docs:` Documentation only
- `perf:` Performance improvement
- `test:` Test additions/changes
- `chore:` Dependencies, tooling

Example: `feat: add webhook signing support`
```

## 7. package.json Metadata

Include plugin metadata in package.json:

```json
{
  "name": "@provider/kit-service",
  "version": "1.0.0",
  "description": "kit adapter for Service Name",
  "type": "module",
  "license": "MIT",
  "author": "Your Name <email@example.com>",
  "repository": {
    "type": "git",
    "url": "https://github.com/provider/kit-service"
  },
  "keywords": ["kit", "adapter", "service-name", "plugin"],
  "kitPlugin": {
    "name": "provider/service",
    "description": "Provisions Service Name",
    "tags": ["category1", "category2"],
    "requiredTools": ["cli-tool-1"],
    "minkitVersion": "0.1.0"
  }
}
```

## 8. Registry Metadata Schema

For plugins submitted to the official registry, include a `plugin.json`:

```json
{
  "name": "provider/service",
  "description": "What this plugin does",
  "version": "1.0.0",
  "author": "Your Name",
  "license": "MIT",
  "repository": "https://github.com/provider/kit-service",
  "package": "@provider/kit-service",
  "kitVersion": ">=0.1.0",
  "tags": ["category", "tag"],
  "published": "2026-04-15T00:00:00Z",
  "downloads": 0,
  "rating": 5.0,
  "install": "npm install @provider/kit-service"
}
```

## Documentation Quality Checklist

- [ ] README is concise (< 200 lines)
- [ ] Installation instructions are clear
- [ ] Configuration section shows all required env vars
- [ ] Examples work without modification
- [ ] API documentation is complete
- [ ] Troubleshooting covers common issues
- [ ] CHANGELOG follows Semantic Versioning
- [ ] All documentation is spell-checked
- [ ] Links are not broken
- [ ] Code examples are tested and pass

## Best Practices

### DO

- Keep documentation DRY (don't repeat sections)
- Use clear headings and structure
- Provide working code examples
- Include error handling examples
- Document required CLI tools
- Explain what env vars do
- List related resources

### DON'T

- Assume user knowledge of the service
- Put all docs in one long README
- Use acronyms without explanation
- Hardcode usernames/credentials in examples
- Document unfinished features
- Forget to update docs when code changes

## Publishing Documentation

When publishing to npm:

1. Ensure all .md files are in package
2. Set `files` in package.json:
   ```json
   "files": ["dist", "docs", "README.md", "CHANGELOG.md"]
   ```
3. Create detailed npm package description
4. Link to GitHub repository
5. Add topic: "kit-plugin"

## Validation

To validate plugin documentation:

```bash
# Check files exist
test -f README.md || echo "Missing README.md"
test -f CHANGELOG.md || echo "Missing CHANGELOG.md"
test -d docs || echo "Missing docs directory"

# Check required sections in README
grep -q "Installation" README.md || echo "Missing Installation section"
grep -q "Configuration" README.md || echo "Missing Configuration section"
grep -q "Usage" README.md || echo "Missing Usage section"
```

## Template

Use this as a template for new plugins:

```bash
kit plugin scaffold my-plugin
# Comes with template files following these standards
```

All generated templates follow this documentation standard.
