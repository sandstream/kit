/**
 * sandstream-kit-adapter-sdk
 *
 * Core types for kit service provisioning adapters.
 * Import this package to build custom adapters without depending on the full kit codebase.
 *
 * FROZEN PUBLIC API (v1.0.0). This package follows its own semantic-versioning
 * track, independent of the kit CLI version. Every export below is part of the
 * frozen 1.x contract: shapes will not change in a breaking way within 1.x. See
 * CHANGELOG.md for the freeze record and the kit-compatibility matrix. Consumers
 * should pin "sandstream-kit-adapter-sdk": "^1.0.0".
 *
 * @packageDocumentation
 *
 * @example
 * ```typescript
 * import type { ServiceAdapter, AdapterContext, ProvisionResult } from "sandstream-kit-adapter-sdk";
 *
 * export const myAdapter: ServiceAdapter = {
 *   name: "my-service/thing",
 *   description: "Provisions my service",
 *   getRequiredTools: () => [],
 *   check: async (ctx) => !!ctx.existingEnv.MY_SERVICE_KEY,
 *   provision: async (ctx) => {
 *     const key = ctx.existingEnv.MY_SERVICE_KEY;
 *     if (key) return { success: true, message: "Already configured", secrets: { MY_SERVICE_KEY: key } };
 *     return { success: false, message: "Set MY_SERVICE_KEY in .env.local", error: "Missing MY_SERVICE_KEY" };
 *   },
 * };
 * ```
 */

/**
 * Result of a provisioning operation.
 *
 * @public Frozen in adapter-sdk 1.0.0.
 */
export interface ProvisionResult {
  /** Whether provisioning succeeded */
  success: boolean;

  /** Human-readable message describing the result */
  message: string;

  /** Secrets to write to .env.local (e.g., API keys, tokens) */
  secrets?: Record<string, string>;

  /** Configuration metadata to store in skills-lock.json */
  config?: Record<string, unknown>;

  /** Error message if provisioning failed */
  error?: string;
}

/**
 * Context provided to adapter methods.
 *
 * @public Frozen in adapter-sdk 1.0.0.
 */
export interface AdapterContext {
  /** Project name (if available) */
  projectName?: string;

  /** Absolute path to the project directory */
  projectPath: string;

  /** Existing environment variables from .env.local */
  existingEnv: Record<string, string>;
}

/**
 * Service adapter interface
 *
 * Implement this interface to create a custom service adapter.
 * Adapters should be stateless and idempotent.
 *
 * @public Frozen in adapter-sdk 1.0.0.
 */
export interface ServiceAdapter {
  /** Unique identifier for the service (e.g., "stripe/payments") */
  name: string;

  /** Human-readable description of what the adapter provisions */
  description: string;

  /**
   * Check if the service is already provisioned
   *
   * Should return true if provisioning can be skipped.
   * Common checks: environment variables exist, CLI is authenticated, resources exist.
   */
  check(context: AdapterContext): Promise<boolean>;

  /**
   * Provision the service
   *
   * Performs the actual provisioning work. Should be idempotent where possible.
   */
  provision(context: AdapterContext): Promise<ProvisionResult>;

  /**
   * Get required CLI tools
   *
   * Returns a list of CLI tool names that must be installed for this adapter.
   * Return an empty array for API-based adapters.
   */
  getRequiredTools(): string[];
}

/**
 * Registry of available service adapters
 *
 * Keys follow the pattern: "<provider>/<service>" (e.g., "stripe/payments")
 *
 * @public Frozen in adapter-sdk 1.0.0.
 */
export interface AdapterRegistry {
  [key: string]: ServiceAdapter;
}

/**
 * Read-only-mode guard for plugin write surfaces.
 *
 * Plugins shouldn't import kit-core directly (creates monorepo coupling
 * + private-package leaks). The contract is environment-level: when
 * `KIT_READ_ONLY=1` is set in the process tree, every mutating
 * plugin function refuses with a structured error.
 *
 * Usage in plugin write surfaces:
 *
 *   import { assertNotReadOnly } from "sandstream-kit-adapter-sdk";
 *
 *   export async function createWebhookEndpoint(client, params) {
 *     assertNotReadOnly("stripe/createWebhookEndpoint");
 *     // ...
 *   }
 *
 * Throws ReadOnlyModeError (catchable) so the calling CLI can convert
 * it to a clean refusal message rather than a stack-trace dump.
 *
 * @public Frozen in adapter-sdk 1.0.0.
 */
export class ReadOnlyModeError extends Error {
  readonly operation: string;
  constructor(operation: string) {
    super(`read-only mode active — refusing "${operation}"`);
    this.name = "ReadOnlyModeError";
    this.operation = operation;
  }
}

/**
 * True when kit is running in read-only mode (KIT_READ_ONLY=1).
 *
 * @public Frozen in adapter-sdk 1.0.0.
 */
export function isReadOnlyMode(): boolean {
  const v = process.env.KIT_READ_ONLY;
  return v === "1" || v === "true";
}

/**
 * Throw {@link ReadOnlyModeError} when in read-only mode; otherwise no-op.
 *
 * @public Frozen in adapter-sdk 1.0.0.
 */
export function assertNotReadOnly(operation: string): void {
  if (isReadOnlyMode()) {
    throw new ReadOnlyModeError(operation);
  }
}
