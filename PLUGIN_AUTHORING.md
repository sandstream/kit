# Plugin Authoring Guide

kit supports community-built adapter plugins. Plugins are regular npm packages that export one or more `ServiceAdapter` implementations. Once installed, they integrate with `kit add`, `kit check`, and the `kit_add` MCP tool transparently.

---

## Quick start

```bash
kit create-plugin my-service
cd sandstream-kit-plugin-my-service
npm run build
npm test
```

This scaffolds a working adapter in `./sandstream-kit-plugin-my-service/` that you can customise and publish.

---

## Plugin package structure

```
sandstream-kit-plugin-my-service/
  src/
    my-service.ts         # ServiceAdapter implementation
    my-service.test.ts    # Tests
    index.ts              # Exports { adapter } or { adapters }
  dist/                   # Built output (TypeScript → JS + .d.ts)
  package.json
  tsconfig.json
  README.md
```

### `package.json` requirements

```json
{
  "name": "sandstream-kit-plugin-my-service",
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "peerDependencies": {
    "sandstream-kit-adapter-sdk": ">=0.1.0"
  }
}
```

### `src/index.ts` export shape

Export **one** of these two shapes — kit will auto-detect:

```typescript
// Single adapter
export { myServiceAdapter as adapter } from "./my-service.js";

// Multiple adapters
export { adapters } from "./my-service.js";
```

---

## Implementing `ServiceAdapter`

Install the SDK types:

```bash
npm install --save-dev sandstream-kit-adapter-sdk
```

```typescript
import type { ServiceAdapter, AdapterContext, ProvisionResult } from "sandstream-kit-adapter-sdk";

export const myServiceAdapter: ServiceAdapter = {
  // Unique identifier: "<provider>/<resource>" pattern
  name: "my-service/api",
  description: "Provisions My Service API credentials",

  // List CLI tools required before provision() can run.
  // Return [] for API-based adapters.
  getRequiredTools(): string[] {
    return [];                // or: ["my-cli"]
  },

  // Return true if the service is already provisioned.
  // Used by `kit check` to skip re-provisioning.
  async check(context: AdapterContext): Promise<boolean> {
    return !!context.existingEnv["MY_SERVICE_KEY"];
  },

  // Provision the service and return secrets/config.
  async provision(context: AdapterContext): Promise<ProvisionResult> {
    const key = context.existingEnv["MY_SERVICE_KEY"];

    // Key-reuse pattern: never create new resources if credentials exist
    if (key) {
      return {
        success: true,
        message: "MY_SERVICE_KEY already configured",
        secrets: { MY_SERVICE_KEY: key },
      };
    }

    // Option A: guide the user to obtain a key manually
    return {
      success: false,
      error: "Missing MY_SERVICE_KEY",
      message: [
        "Get your API key at https://my-service.com/dashboard/api-keys",
        "Then add to .env.local: MY_SERVICE_KEY=your_key_here",
      ].join("\n"),
    };

    // Option B: create resources via REST API
    // const resp = await fetch("https://api.my-service.com/keys", {
    //   method: "POST",
    //   headers: { Authorization: `Bearer ${context.existingEnv["MY_SERVICE_API_TOKEN"]}` },
    // });
    // const { key } = await resp.json();
    // return { success: true, message: "Created API key", secrets: { MY_SERVICE_KEY: key } };
  },
};
```

### `AdapterContext` reference

| Property | Type | Description |
|----------|------|-------------|
| `projectPath` | `string` | Absolute path to the project root |
| `projectName` | `string \| undefined` | Project name from `.kit.toml` |
| `existingEnv` | `Record<string, string>` | Current `.env.local` contents |

### `ProvisionResult` reference

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `success` | `boolean` | ✓ | Whether provisioning succeeded |
| `message` | `string` | ✓ | Human-readable result |
| `secrets` | `Record<string, string>` | | Keys written to `.env.local` |
| `config` | `Record<string, unknown>` | | Metadata for `skills-lock.json` |
| `error` | `string` | | Error message on failure |

---

## Testing your plugin

Write tests using `node:test` (built-in, no dependencies):

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { myServiceAdapter } from "./my-service.js";

const ctx = (env: Record<string, string> = {}) => ({
  projectPath: "/tmp/test",
  projectName: "test",
  existingEnv: env,
});

describe("myServiceAdapter", () => {
  it("check returns false when key absent", async () => {
    assert.equal(await myServiceAdapter.check(ctx()), false);
  });

  it("provision returns existing key", async () => {
    const result = await myServiceAdapter.provision(ctx({ MY_SERVICE_KEY: "sk_test" }));
    assert.equal(result.success, true);
    assert.equal(result.secrets?.MY_SERVICE_KEY, "sk_test");
  });
});
```

Run tests:

```bash
npm run build && npm test
```

---

## Registering your plugin

Users add your plugin to their project by:

1. Installing it: `npm install --save-dev sandstream-kit-plugin-my-service`
2. Adding it to `package.json`:

```json
{
  "kitPlugins": ["sandstream-kit-plugin-my-service"]
}
```

kit reads `kitPlugins` at runtime and merges your adapter into the registry alongside all built-in adapters. No kit source changes needed.

---

## Publishing to npm

```bash
npm run build
npm pack --dry-run   # verify contents
npm publish
```

Name your package `sandstream-kit-plugin-<service>` so it's discoverable.

---

## Security considerations

Plugins run with the **full permissions of the current process**. Before installing a community plugin:

- Review the source code
- Prefer packages from trusted maintainers with good download counts
- Pin to an exact version in `package.json` (e.g. `"1.2.3"` not `"^1.2.3"`)
- Be especially careful with plugins that provision or access production secrets

kit will warn when loading an unrecognised plugin for the first time (future feature).

---

## Reference implementation

`packages/sandstream-kit-plugin-railway/` in this repo is the canonical example. It demonstrates:

- CLI-based provisioning (`railway` CLI)
- Key-reuse pattern
- Error handling for missing/failed CLI
- Test structure
- Package configuration

---

## Using `kit create-plugin`

The fastest way to get started:

```bash
kit create-plugin <short-name>
```

This creates `./sandstream-kit-plugin-<short-name>/` with a working adapter, tests, and configuration. The generated plugin passes `npm run build` and `npm test` immediately so you can start from green.
