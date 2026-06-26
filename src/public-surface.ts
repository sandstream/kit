/**
 * Public-surface collector for kit's breaking-change detector.
 *
 * Emits a deterministic snapshot of every contract kit promises to keep stable
 * across the 2.x line: the top-level command names + their stability tiers, the
 * documented help keys, the config schema (known section names + schema version),
 * the adapter-sdk public exports + its independent version, the MCP tool names,
 * and the documented exit-code set.
 *
 * scripts/gen-public-surface.mjs serializes this into contracts/public-surface.json
 * and public-surface.test.ts diffs a fresh collection against that committed
 * snapshot. Any drift fails the test with instructions to review, regenerate, and
 * flag breaking changes. This is what makes the stability promise ENFORCED rather
 * than merely asserted.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { COMMANDS, COMMAND_HELP, COMMAND_TIERS, type CommandTier } from "./cli.js";
import { KNOWN_SECTIONS, CONFIG_SCHEMA_VERSION } from "./config.js";
import { KIT_MCP_TOOLS } from "./mcp-server.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * The frozen public-export names of sandstream-kit-adapter-sdk@1.x. TypeScript
 * interfaces erase at runtime, so the contract list is declared here explicitly;
 * the adapter-sdk SDK CHANGELOG.md is the human-readable source of the same set.
 * Changing this list is an adapter-sdk surface change and must bump that package.
 */
const ADAPTER_SDK_EXPORTS: readonly string[] = [
  "AdapterContext",
  "AdapterRegistry",
  "ProvisionResult",
  "ReadOnlyModeError",
  "ServiceAdapter",
  "assertNotReadOnly",
  "isReadOnlyMode",
];

/** kit's documented process exit codes: 0 = success, 1 = failure/refusal. */
const EXIT_CODES: readonly number[] = [0, 1];

export interface PublicSurface {
  /** Top-level command name -> stability tier. */
  commands: Record<string, CommandTier>;
  /** Every COMMAND_HELP key (top-level + "<cmd> <sub>" subcommands), sorted. */
  helpKeys: string[];
  config: {
    schemaVersion: number;
    knownSections: string[];
  };
  adapterSdk: {
    version: string;
    exports: string[];
  };
  mcpTools: string[];
  exitCodes: number[];
}

function readAdapterSdkVersion(): string {
  // dist/public-surface.js -> repo root is one level up; mirrors how cli.ts reads
  // its own package.json. Reads the SDK's independently-versioned package.json.
  const pkgPath = join(__dirname, "..", "packages", "adapter-sdk", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version: string };
  return pkg.version;
}

/** Collect the live public surface from the source of truth in each module. */
export function collectPublicSurface(): PublicSurface {
  const commands: Record<string, CommandTier> = {};
  for (const name of Object.keys(COMMANDS)) {
    // Default any (theoretically) untiered command to "experimental" rather than
    // crashing. Parity tests guarantee a tier exists for every command.
    commands[name] = COMMAND_TIERS[name] ?? "experimental";
  }

  return {
    commands,
    helpKeys: Object.keys(COMMAND_HELP),
    config: {
      schemaVersion: CONFIG_SCHEMA_VERSION,
      knownSections: [...KNOWN_SECTIONS],
    },
    adapterSdk: {
      version: readAdapterSdkVersion(),
      exports: [...ADAPTER_SDK_EXPORTS],
    },
    mcpTools: [...KIT_MCP_TOOLS],
    exitCodes: [...EXIT_CODES],
  };
}

/** Recursively sort object keys + array members so serialization is order-stable. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    // Sort arrays of primitives so reordering source declarations is not a "diff".
    const mapped = value.map(canonicalize);
    if (mapped.every((v) => typeof v === "string" || typeof v === "number")) {
      return [...mapped].sort((a, b) => String(a).localeCompare(String(b)));
    }
    return mapped;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * Deterministic JSON for the snapshot: keys sorted, primitive arrays sorted,
 * 2-space indent, trailing newline. The gen script and the golden test both go
 * through this, so a byte-for-byte string compare is a faithful drift check.
 */
export function serializePublicSurface(surface: PublicSurface): string {
  return `${JSON.stringify(canonicalize(surface), null, 2)}\n`;
}
