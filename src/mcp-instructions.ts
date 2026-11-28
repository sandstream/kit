/**
 * The `instructions` an MCP server returns from `initialize`.
 *
 * MCP clients put this text into the agent's context next to the tool definitions, so it can
 * carry the same poisoning a tool description can, and it can change after the server was
 * trusted. `kit triage mcp` read only `tools/list`: a server that rewrote its instructions and
 * kept its tools reported "tool set unchanged since pin" (kit-research copybook-vs-kit).
 *
 * The text gets the injection scan tool descriptions get, and its hash is pinned beside the
 * tool-set hash. A pin from before this field reports "not pinned yet" instead of passing as
 * unchanged. Pure; the caller reads the files and the pin.
 */
import { createHash } from "node:crypto";
import { findInjection } from "./memory/injection.js";
import { markdownImageExfil } from "./instruction-rules.js";
import type { McpToolFinding } from "./mcp-triage.js";

/**
 * `not-read`: no `initialize` result was given, so nothing can be said about the instructions.
 * `not-pinned`: the pin predates instruction pinning; review the text, then re-pin.
 */
export type InstructionsDrift = "new" | "unchanged" | "changed" | "not-pinned" | "not-read";

/** The subset of a stored pin this module reads. */
export interface InstructionsPin {
  instructionsHash?: string;
}

const INITIALIZE_KEYS = ["protocolVersion", "serverInfo", "capabilities"] as const;

/**
 * The server instructions in a loaded JSON document: an `initialize` result, the JSON-RPC
 * response around it, or a manifest that carries `instructions` beside `tools`. An `initialize`
 * result without the field yields "" (read, and empty). Anything else yields undefined (not read).
 */
export function extractServerInstructions(doc: unknown): string | undefined {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return undefined;
  const o = doc as Record<string, unknown>;
  if (typeof o.instructions === "string") return o.instructions;
  if (o.result && typeof o.result === "object") return extractServerInstructions(o.result);
  return INITIALIZE_KEYS.some((k) => k in o) ? "" : undefined;
}

export function hashInstructions(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The tool-description scan, run over the instructions. Reported under `(server) · instructions`. */
export function instructionsFindings(text: string | undefined): McpToolFinding[] {
  if (!text) return [];
  const findings: McpToolFinding[] = findInjection(text).map((f) => ({
    tool: "(server)",
    field: "instructions",
    label: f.label,
    confidence: f.confidence,
  }));
  if (markdownImageExfil(text)) {
    findings.push({
      tool: "(server)",
      field: "instructions",
      label: "markdown-image-exfil (a query-string image in replies leaks data when it renders)",
      confidence: "heuristic",
    });
  }
  return findings;
}

/** Compare the instructions read now with the pin. Unread text is never "unchanged". */
export function classifyInstructionsDrift(
  pin: InstructionsPin | undefined,
  current: string | undefined,
): InstructionsDrift {
  if (current === undefined) return "not-read";
  if (!pin) return "new";
  if (pin.instructionsHash === undefined) return "not-pinned";
  return pin.instructionsHash === hashInstructions(current) ? "unchanged" : "changed";
}
