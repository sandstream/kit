/**
 * `kit triage mcp <server> --tools <manifest.json> [--init <initialize.json>] [--pin]`: static MCP
 * metadata triage (G3). Reads a tools/list manifest and the server's `initialize` result, runs
 * kit's injection detector over every tool description, parameter doc and the server
 * `instructions` (tool poisoning), and compares content hashes against a pin (rug-pull / drift).
 * Exits non-zero on high-confidence poisoning or a silent change. `--pin` records the pin.
 * Deterministic, zero-LLM.
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { c } from "../utils/colors.js";
import { hasFlag, flagValue } from "../utils/flags.js";
import { triageMcpTools, extractToolDefs, type McpTriageResult } from "../mcp-triage.js";
import {
  classifyInstructionsDrift,
  extractServerInstructions,
  hashInstructions,
  instructionsFindings,
  type InstructionsDrift,
} from "../mcp-instructions.js";

const MCP_PIN_FILE = ".kit-mcp-pins.json";

interface McpPin {
  hash: string;
  toolCount: number;
  pinnedAt: string;
  /** sha256 of the `initialize` result's `instructions`; absent in older pins. */
  instructionsHash?: string;
}

interface McpInputs {
  tools: ReturnType<typeof extractToolDefs>;
  /** undefined: neither file carried an `initialize` result. */
  instructions: string | undefined;
}

const USAGE = "usage: kit triage mcp <server> --tools <manifest.json> [--init <init.json>] [--pin]";

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(resolve(process.cwd(), path), "utf-8"));
}

/** Read the manifest and the optional `initialize` result. Prints and returns null on error. */
async function readInputs(
  toolsPath: string,
  initPath: string | undefined,
): Promise<McpInputs | null> {
  let path = toolsPath;
  try {
    const manifest = await readJson(toolsPath);
    path = initPath ?? toolsPath;
    const init = initPath ? await readJson(initPath) : manifest;
    const tools = extractToolDefs(manifest);
    if (tools.length > 0) return { tools, instructions: extractServerInstructions(init) };
    console.error(`${c.red}no tool definitions found in ${toolsPath}${c.reset}`);
  } catch (err) {
    console.error(
      `${c.red}could not read ${path}: ${err instanceof Error ? err.message : err}${c.reset}`,
    );
  }
  return null;
}

const TOOL_DRIFT: Record<string, string> = {
  new: `${c.dim}new server — no prior pin${c.reset}`,
  unchanged: `${c.green}✓ tool set unchanged since pin${c.reset}`,
  changed: `${c.red}✗ RUG-PULL: tool set changed since pin${c.reset}`,
  "legacy-pin": `${c.yellow}! pin predates title, annotation and output-schema coverage — review them, then re-pin with --pin${c.reset}`,
  unknown: `${c.dim}drift unknown${c.reset}`,
};

const INSTRUCTIONS_DRIFT: Record<InstructionsDrift, string> = {
  new: `${c.dim}server instructions: no prior pin${c.reset}`,
  unchanged: `${c.green}✓ server instructions unchanged since pin${c.reset}`,
  changed: `${c.red}✗ RUG-PULL: server instructions changed since pin${c.reset}`,
  "not-pinned": `${c.yellow}! server instructions not pinned yet — review them, then re-pin with --pin${c.reset}`,
  "not-read": `${c.yellow}! server instructions not read — pass the initialize result with --init <file>${c.reset}`,
};

function printReport(
  server: string,
  result: McpTriageResult,
  findings: McpTriageResult["findings"],
  drift: InstructionsDrift,
): void {
  console.log(`${c.bold}MCP triage: ${server}${c.reset} (${result.toolCount} tools)`);
  if (findings.length === 0) console.log(`  ${c.green}✓ no tool-poisoning patterns${c.reset}`);
  for (const f of findings) {
    const tag =
      f.confidence === "high" ? `${c.red}[HIGH]${c.reset}` : `${c.yellow}[heur]${c.reset}`;
    console.log(`  ${tag} ${f.tool} · ${f.field}: ${f.label}`);
  }
  console.log(`  ${TOOL_DRIFT[result.drift]}`);
  console.log(`  ${INSTRUCTIONS_DRIFT[drift]}`);
  console.log(`  ${c.dim}hash ${result.toolsetHash.slice(0, 16)}…${c.reset}`);
}

/** Record the pin. Text that was not read keeps the hash it was pinned with. */
async function writePin(
  pinPath: string,
  pins: Record<string, McpPin>,
  server: string,
  result: McpTriageResult,
  instructions: string | undefined,
): Promise<boolean> {
  const instructionsHash =
    instructions === undefined ? pins[server]?.instructionsHash : hashInstructions(instructions);
  pins[server] = {
    hash: result.toolsetHash,
    toolCount: result.toolCount,
    pinnedAt: new Date().toISOString(),
    ...(instructionsHash === undefined ? {} : { instructionsHash }),
  };
  try {
    await writeFile(pinPath, JSON.stringify(pins, null, 2) + "\n", "utf-8");
    console.log(`  ${c.green}✓ pinned${c.reset}`);
    return true;
  } catch (err) {
    console.error(
      `${c.red}could not write pin: ${err instanceof Error ? err.message : err}${c.reset}`,
    );
    return false;
  }
}

export async function cmdTriageMcp(args: string[]): Promise<boolean> {
  const server = args.find((a) => !a.startsWith("--"));
  const toolsPath = flagValue(args, "--tools");
  if (!server || !toolsPath) {
    console.error(`${c.red}${USAGE}${c.reset}`);
    console.error(
      `${c.dim}manifest = a tools/list response (or a JSON array of tool defs) for the server; init = its initialize result${c.reset}`,
    );
    return false;
  }
  const inputs = await readInputs(toolsPath, flagValue(args, "--init"));
  if (!inputs) return false;

  const pinPath = resolve(process.cwd(), MCP_PIN_FILE);
  const pins = await readMcpPins(pinPath);
  const result = triageMcpTools(server, inputs.tools, pins[server]?.hash);
  const findings = [...result.findings, ...instructionsFindings(inputs.instructions)];
  const drift = classifyInstructionsDrift(pins[server], inputs.instructions);
  printReport(server, result, findings, drift);
  const poisoned = findings.some((f) => f.confidence === "high");

  if (hasFlag(args, "--pin")) {
    // Pinning accepts the current state as trusted, so drift can't fail this run.
    return (await writePin(pinPath, pins, server, result, inputs.instructions)) && !poisoned;
  }
  const passed = result.passed && !poisoned && drift !== "changed";
  if (!passed) {
    console.error(`${c.red}✗ MCP triage failed (poisoning or rug-pull) — review above${c.reset}`);
  }
  return passed;
}

async function readMcpPins(pinPath: string): Promise<Record<string, McpPin>> {
  try {
    return JSON.parse(await readFile(pinPath, "utf-8")) as Record<string, McpPin>;
  } catch {
    return {};
  }
}
