/**
 * kit — MCP server triage (G3).
 *
 * Tool poisoning — malicious instructions hidden in an MCP tool's metadata
 * (description / parameter docs) — is the top MCP client-side vulnerability, and
 * deployed clients largely lack static tool-metadata validation (gap analysis §1.3,
 * verified 3-0; NSA MCP CSI). A "rug pull" is the same server silently changing a
 * tool definition after you trusted it.
 *
 * This is the deterministic, zero-LLM remedy every MCP paper leads with:
 *   1. static metadata analysis — run kit's R7 injection detector over every tool
 *      description and parameter doc, so a poisoned tool is caught before use;
 *   2. drift/rug-pull detection — a stable content hash of the tool set, pinned on
 *      first sight, compared on every re-check so a silent redefinition is caught.
 *
 * The analysis + hash are pure and unit-testable; only pin read/write touches disk.
 */
import { createHash } from "node:crypto";
import { findInjection } from "./memory/injection.js";

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface McpToolFinding {
  tool: string;
  /** Where in the tool the pattern was found: "description" or "param:<path>". */
  field: string;
  label: string;
  confidence: "high" | "heuristic";
}

export type McpDrift = "new" | "unchanged" | "changed" | "unknown";

export interface McpTriageResult {
  server: string;
  toolCount: number;
  findings: McpToolFinding[];
  toolsetHash: string;
  drift: McpDrift;
  /** No high-confidence poisoning AND not a rug-pull (drift !== "changed"). */
  passed: boolean;
}

/** Recursively collect { path, text } for every `description` string in a JSON schema. */
function collectSchemaDescriptions(schema: unknown, path = ""): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  if (!schema || typeof schema !== "object") return out;
  const obj = schema as Record<string, unknown>;
  if (typeof obj.description === "string") {
    out.push({ path: path || "schema", text: obj.description });
  }
  const props = obj.properties;
  if (props && typeof props === "object") {
    for (const [key, val] of Object.entries(props as Record<string, unknown>)) {
      out.push(...collectSchemaDescriptions(val, path ? `${path}.${key}` : key));
    }
  }
  // arrays / nested schemas
  if (obj.items) out.push(...collectSchemaDescriptions(obj.items, path ? `${path}[]` : "[]"));
  return out;
}

/**
 * Statically analyze MCP tool definitions for tool-poisoning patterns. Pure +
 * deterministic: every tool description and parameter doc is run through the R7
 * injection detector, and a stable content hash of the whole tool set is computed
 * for drift detection.
 */
export function analyzeMcpTools(tools: McpToolDef[]): {
  findings: McpToolFinding[];
  toolsetHash: string;
} {
  const findings: McpToolFinding[] = [];
  for (const tool of tools) {
    const name = tool.name || "(unnamed)";
    if (tool.description) {
      for (const f of findInjection(tool.description)) {
        findings.push({
          tool: name,
          field: "description",
          label: f.label,
          confidence: f.confidence,
        });
      }
    }
    for (const { path, text } of collectSchemaDescriptions(tool.inputSchema)) {
      for (const f of findInjection(text)) {
        findings.push({
          tool: name,
          field: `param:${path}`,
          label: f.label,
          confidence: f.confidence,
        });
      }
    }
  }
  return { findings, toolsetHash: hashToolset(tools) };
}

/** Deterministic content hash of a tool set — order-independent, whitespace-exact. */
export function hashToolset(tools: McpToolDef[]): string {
  const canonical = tools
    .map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: stableStringify(t.inputSchema ?? null),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

/** JSON.stringify with object keys sorted recursively, so key order never changes the hash. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/** Compare a freshly computed hash against a pinned one. */
export function classifyDrift(pinnedHash: string | undefined, currentHash: string): McpDrift {
  if (!pinnedHash) return "new";
  return pinnedHash === currentHash ? "unchanged" : "changed";
}

/**
 * Assemble a full triage result from tool defs + an optional pinned hash. Pure —
 * the caller supplies the pin (read from disk) and decides whether to persist it.
 */
export function triageMcpTools(
  server: string,
  tools: McpToolDef[],
  pinnedHash?: string,
): McpTriageResult {
  const { findings, toolsetHash } = analyzeMcpTools(tools);
  const drift = classifyDrift(pinnedHash, toolsetHash);
  const hasHighPoisoning = findings.some((f) => f.confidence === "high");
  return {
    server,
    toolCount: tools.length,
    findings,
    toolsetHash,
    drift,
    passed: !hasHighPoisoning && drift !== "changed",
  };
}

/** Normalize a loaded manifest into a tool-def array. Accepts an array, a
 *  `{ tools: [...] }` tools/list response, or an `{ mcpServers: {...} }` config
 *  with inline `tools`. Returns [] when no tools are present. */
export function extractToolDefs(manifest: unknown): McpToolDef[] {
  const asTool = (t: unknown): McpToolDef | null => {
    if (!t || typeof t !== "object") return null;
    const o = t as Record<string, unknown>;
    if (typeof o.name !== "string") return null;
    return {
      name: o.name,
      description: typeof o.description === "string" ? o.description : undefined,
      inputSchema: o.inputSchema ?? o.input_schema ?? o.parameters,
    };
  };
  if (Array.isArray(manifest)) {
    return manifest.map(asTool).filter((t): t is McpToolDef => t !== null);
  }
  if (manifest && typeof manifest === "object") {
    const o = manifest as Record<string, unknown>;
    if (Array.isArray(o.tools)) {
      return o.tools.map(asTool).filter((t): t is McpToolDef => t !== null);
    }
  }
  return [];
}
