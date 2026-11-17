/**
 * kit — MCP server triage (G3).
 *
 * Tool poisoning — malicious instructions hidden in an MCP tool's metadata
 * (description / parameter docs) — is a top MCP client-side vulnerability, and deployed
 * clients need static tool-metadata validation (NSA MCP CSI). A "rug pull" is the same
 * server silently changing a tool definition after you trusted it.
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
  /** Display name. Clients show it, and models read it. */
  title?: string;
  /** Structured-output schema (MCP 2025-06-18). FastMCP derives it from the return type. */
  outputSchema?: unknown;
  /** Behaviour hints such as `readOnlyHint`, which some clients use to auto-approve. */
  annotations?: unknown;
}

export interface McpToolFinding {
  tool: string;
  /** Where in the tool the pattern was found: "description" or "param:<path>". */
  field: string;
  label: string;
  confidence: "high" | "heuristic";
}

/**
 * `legacy-pin`: the pin matches the tool set as kit hashed it before titles, annotations and
 * output schemas were covered. The old fields are unchanged; the new ones are not yet pinned.
 */
export type McpDrift = "new" | "unchanged" | "changed" | "legacy-pin" | "unknown";

export interface McpTriageResult {
  server: string;
  toolCount: number;
  findings: McpToolFinding[];
  toolsetHash: string;
  drift: McpDrift;
  /** No high-confidence poisoning AND not a rug-pull (drift !== "changed"). */
  passed: boolean;
}

const SCHEMA_TEXT_KEYS = ["description", "title", "default"] as const;
const SCHEMA_CHILD_LISTS = ["anyOf", "oneOf", "allOf", "prefixItems"] as const;
const SCHEMA_CHILD_MAPS = ["properties", "$defs", "definitions", "patternProperties"] as const;
const MAX_SCHEMA_DEPTH = 32;

/**
 * Collect every string a client or model can read from a JSON schema: `description`,
 * `title`, string `default`s and `examples`, through properties, items, unions
 * (`anyOf`/`oneOf`/`allOf`) and `$defs`. Pydantic and FastMCP put nested models in unions
 * (an `Optional[Model]` parameter) and in `$defs`, so a walk of `properties` alone misses them.
 */
function collectSchemaDescriptions(
  schema: unknown,
  path = "",
  depth = 0,
): { path: string; text: string }[] {
  if (!schema || typeof schema !== "object" || depth > MAX_SCHEMA_DEPTH) return [];
  const obj = schema as Record<string, unknown>;
  const out = ownSchemaTexts(obj, path);
  for (const [child, childPath] of childSchemas(obj, path)) {
    out.push(...collectSchemaDescriptions(child, childPath, depth + 1));
  }
  return out;
}

const joinPath = (path: string, suffix: string): string => (path ? `${path}.${suffix}` : suffix);

/** The text fields of one schema node, without its children. */
function ownSchemaTexts(
  obj: Record<string, unknown>,
  path: string,
): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  for (const key of SCHEMA_TEXT_KEYS) {
    const v = obj[key];
    if (typeof v !== "string") continue;
    out.push({ path: key === "description" ? path || "schema" : joinPath(path, key), text: v });
  }
  const examples = Array.isArray(obj.examples) ? obj.examples : [];
  for (const v of examples) {
    if (typeof v === "string") out.push({ path: joinPath(path, "examples"), text: v });
  }
  return out;
}

/** The sub-schemas of one node, each with the path its findings are reported under. */
function childSchemas(obj: Record<string, unknown>, path: string): [unknown, string][] {
  const out: [unknown, string][] = [];
  for (const key of SCHEMA_CHILD_MAPS) {
    const map = obj[key];
    if (!map || typeof map !== "object") continue;
    for (const [name, val] of Object.entries(map as Record<string, unknown>)) {
      out.push([
        val,
        key === "properties" ? joinPath(path, name) : joinPath(path, `${key}.${name}`),
      ]);
    }
  }
  for (const key of SCHEMA_CHILD_LISTS) {
    const list = obj[key];
    if (Array.isArray(list))
      list.forEach((val, i) => out.push([val, joinPath(path, `${key}[${i}]`)]));
  }
  if (obj.items) out.push([obj.items, path ? `${path}[]` : "[]"]);
  if (obj.additionalProperties && typeof obj.additionalProperties === "object") {
    out.push([obj.additionalProperties, joinPath(path, "additionalProperties")]);
  }
  return out;
}

/** Every text field of one tool that a client or model reads, with where it came from. */
function toolTexts(tool: McpToolDef): { field: string; text: string }[] {
  const texts: { field: string; text: string }[] = [];
  if (tool.description) texts.push({ field: "description", text: tool.description });
  if (tool.title) texts.push({ field: "title", text: tool.title });
  const ann = tool.annotations as Record<string, unknown> | undefined;
  if (ann && typeof ann === "object" && typeof ann.title === "string") {
    texts.push({ field: "annotations.title", text: ann.title });
  }
  for (const { path, text } of collectSchemaDescriptions(tool.inputSchema)) {
    texts.push({ field: `param:${path}`, text });
  }
  for (const { path, text } of collectSchemaDescriptions(tool.outputSchema)) {
    texts.push({ field: `output:${path}`, text });
  }
  return texts;
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
    for (const { field, text } of toolTexts(tool)) {
      for (const f of findInjection(text)) {
        findings.push({ tool: name, field, label: f.label, confidence: f.confidence });
      }
    }
  }
  return { findings, toolsetHash: hashToolset(tools) };
}

/** Recursively collect property-key paths from a JSON schema (for name-based checks). */
function collectParamNames(schema: unknown, path = ""): string[] {
  if (!schema || typeof schema !== "object") return [];
  const obj = schema as Record<string, unknown>;
  const out: string[] = [];
  const props = obj.properties;
  if (props && typeof props === "object") {
    for (const [key, val] of Object.entries(props as Record<string, unknown>)) {
      const p = joinPath(path, key);
      out.push(p, ...collectParamNames(val, p));
    }
  }
  for (const [child, childPath] of paramChildren(obj, path)) {
    out.push(...collectParamNames(child, childPath));
  }
  return out;
}

/** Sub-schemas that hold parameters under the same name path: items, unions and `$defs`. */
function paramChildren(obj: Record<string, unknown>, path: string): [unknown, string][] {
  const out: [unknown, string][] = [];
  if (obj.items) out.push([obj.items, path ? `${path}[]` : "[]"]);
  for (const key of SCHEMA_CHILD_LISTS) {
    const list = obj[key];
    if (Array.isArray(list)) for (const val of list) out.push([val, path]);
  }
  for (const key of ["$defs", "definitions"]) {
    const map = obj[key];
    if (!map || typeof map !== "object") continue;
    for (const val of Object.values(map as Record<string, unknown>)) out.push([val, path]);
  }
  return out;
}

// Deterministic patterns derived from the OWASP/SlowMist MCP-Security-Checklist —
// static, heuristic (never high-confidence, so they surface for review but never
// flip the pass/fail verdict, which stays gated on high-confidence poisoning + drift).
// `system` only as a call (`os.system`, `system_exec`, `system command`): a bare `system` flagged
// "Search the design system docs." (kit-research astryx-revisit-vs-kit).
const DANGEROUS_CAPABILITY =
  /\b(exec|eval|shell|spawn|(os[._-]?)?system[_ -]?(call|exec|command|cmd)|os[._]system|sudo|run[_-]?command|delete[_-]?all|drop[_-]?(table|database)|rm\b)/i;
const SECRET_PARAM =
  /(^|[_-])(token|secret|password|passwd|api[_-]?key|apikey|credential|private[_-]?key)([_-]|$)/i;

/** The field whose text implies arbitrary exec or deletion, name first, or null. */
function dangerousField(tool: McpToolDef): "name" | "description" | null {
  if (DANGEROUS_CAPABILITY.test(tool.name ?? "")) return "name";
  return DANGEROUS_CAPABILITY.test(tool.description ?? "") ? "description" : null;
}

/**
 * Static MCP-Security-Checklist findings over tool defs (SlowMist / OWASP MCP Top 10).
 * Deterministic + heuristic-confidence — advisory review signals, NOT verdict-flipping:
 *  - dangerous-capability: a tool name/description implying arbitrary exec/deletion
 *    (confirm least-privilege + human approval).
 *  - secret-as-parameter: a parameter shaped like a credential (inject at the boundary,
 *    do not accept as a tool arg — MCP01).
 *  - undocumented: a tool with no description (cannot be triaged; MCP checklist).
 *  - unconstrained-input: top-level `additionalProperties: true` (validate inputs).
 */
export function checklistFindings(tools: McpToolDef[]): McpToolFinding[] {
  const findings: McpToolFinding[] = [];
  for (const tool of tools) {
    const name = tool.name || "(unnamed)";
    const dangerous = dangerousField(tool);
    if (dangerous) {
      findings.push({
        tool: name,
        field: dangerous,
        label: "dangerous-capability (confirm least-privilege + human approval)",
        confidence: "heuristic",
      });
    }
    if (!tool.description || tool.description.trim() === "") {
      findings.push({
        tool: name,
        field: "description",
        label: "undocumented tool (cannot be triaged; add a clear description)",
        confidence: "heuristic",
      });
    }
    for (const p of collectParamNames(tool.inputSchema)) {
      const leaf = p.split(".").pop() ?? p;
      if (SECRET_PARAM.test(leaf)) {
        findings.push({
          tool: name,
          field: `param:${p}`,
          label: "secret-shaped parameter (inject at the boundary, not as a tool arg)",
          confidence: "heuristic",
        });
      }
    }
    const schema = tool.inputSchema as Record<string, unknown> | undefined;
    if (schema && typeof schema === "object" && schema.additionalProperties === true) {
      findings.push({
        tool: name,
        field: "schema",
        label: "unconstrained input (additionalProperties: true — validate inputs)",
        confidence: "heuristic",
      });
    }
  }
  return findings;
}

/**
 * Deterministic content hash of a tool set — order-independent, whitespace-exact. Title,
 * annotations and output schema are hashed when present, so flipping `readOnlyHint` or
 * widening an output schema is a rug pull. A tool with none of them hashes as it did before
 * they were covered, so existing pins of such tools still match.
 */
export function hashToolset(tools: McpToolDef[]): string {
  return hashCanonical(tools, true);
}

/** The hash before titles, annotations and output schemas were covered. */
export function legacyHashToolset(tools: McpToolDef[]): string {
  return hashCanonical(tools, false);
}

function hashCanonical(tools: McpToolDef[], extended: boolean): string {
  const canonical = tools
    .map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: stableStringify(t.inputSchema ?? null),
      ...(extended && t.title !== undefined ? { title: t.title } : {}),
      ...(extended && t.annotations !== undefined
        ? { annotations: stableStringify(t.annotations) }
        : {}),
      ...(extended && t.outputSchema !== undefined
        ? { outputSchema: stableStringify(t.outputSchema) }
        : {}),
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
export function classifyDrift(
  pinnedHash: string | undefined,
  currentHash: string,
  legacyHash?: string,
): McpDrift {
  if (!pinnedHash) return "new";
  if (pinnedHash === currentHash) return "unchanged";
  return pinnedHash === legacyHash ? "legacy-pin" : "changed";
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
  const { findings: poisoning, toolsetHash } = analyzeMcpTools(tools);
  // Poisoning findings (can be high-confidence → gate) + advisory MCP-checklist
  // findings (always heuristic → surfaced, never verdict-flipping).
  const findings = [...poisoning, ...checklistFindings(tools)];
  const drift = classifyDrift(pinnedHash, toolsetHash, legacyHashToolset(tools));
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
      ...(typeof o.title === "string" ? { title: o.title } : {}),
      ...((o.outputSchema ?? o.output_schema) !== undefined
        ? { outputSchema: o.outputSchema ?? o.output_schema }
        : {}),
      ...(o.annotations !== undefined ? { annotations: o.annotations } : {}),
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
    // A raw JSON-RPC `tools/list` response: `{ jsonrpc, id, result: { tools } }`.
    if (o.result && typeof o.result === "object") return extractToolDefs(o.result);
  }
  return [];
}
