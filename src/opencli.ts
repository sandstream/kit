/**
 * OpenCLI document generator — kit describes its own command surface in the
 * OpenCLI Specification (https://opencli.org), the "OpenAPI for CLIs" standard.
 *
 * Like public-surface.ts, this derives entirely from the single source of truth
 * (COMMAND_REGISTRY, via COMMANDS / COMMAND_TIERS / COMMAND_HELP / KIT_MCP_TOOLS
 * in cli.ts) — so the OpenCLI doc, the CLI, and the MCP tools can never disagree.
 * scripts/gen-opencli.mjs serializes this to contracts/kit.opencli.json and
 * opencli.test.ts diffs a fresh build against the committed snapshot (drift =
 * test failure), exactly as public-surface does.
 *
 * HONEST-BY-CONSTRUCTION: kit's registry models command NAMES, summaries, stability
 * tiers, MCP exposure, and accepted long-flag names. It still does not model positional
 * args, flag value types, arity, choices, or aliases, so the standard OpenCLI `args` /
 * `flags` arrays remain omitted rather than fabricated. The kit-specific
 * `x-kit-accepted-flags` extension is the dispatch allowlist from flag-surface.ts plus
 * global flags, which is enough for drift/audit tools to answer "does kit accept this
 * documented flag on this command?". We emit JSON (OpenCLI accepts YAML or JSON) to stay
 * dependency-free and byte-deterministic.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  COMMANDS,
  COMMAND_HELP,
  COMMAND_TIERS,
  COMMAND_AUDIENCE,
  type CommandTier,
  type CommandAudience,
} from "./cli.js";
import { COMMAND_FLAGS } from "./flag-surface.js";
import { KIT_MCP_TOOLS } from "./mcp-server.js";
import { GLOBAL_FLAGS } from "./utils/flags.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** OpenCLI spec version this document targets (pre-release; treated as an output format). */
export const OPENCLI_VERSION = "1.0.0-alpha.12";

/** A single command (or command group) node in an OpenCLI document. */
export interface OpenCliCommand {
  kind: "command" | "group";
  summary: string;
  /** kit stability tier — namespaced extension (OpenAPI-style `x-` convention). */
  "x-kit-stability": CommandTier;
  /** True when this verb is also exposed as an MCP tool (`kit_<name>`). */
  "x-kit-mcp": boolean;
  /**
   * Who primarily invokes this command: "human" (interactive/setup — never on
   * the MCP surface), "harness" (hook stdin protocols — on no discovery
   * surface), "agent", or "all". See COMMAND_AUDIENCE in cli.ts.
   */
  "x-kit-audience": CommandAudience;
  /**
   * True when accepted long-flag names are modeled for this command via
   * `x-kit-accepted-flags`. Positional args and flag type/arity metadata are still
   * intentionally omitted from the standard OpenCLI fields.
   */
  "x-kit-args-modeled": boolean;
  /**
   * Dispatch-level long flags accepted by this command, including kit globals. Kept
   * namespaced because OpenCLI's standard `flags` objects require type/arity metadata
   * kit does not yet model.
   */
  "x-kit-accepted-flags"?: string[];
  /** Nested subcommands, present only on `kind: "group"`. */
  commands?: Record<string, OpenCliCommand>;
}

export interface OpenCliDoc {
  opencliVersion: string;
  info: { title: string; summary: string; version: string; binary: string };
  commands: Record<string, OpenCliCommand>;
}

function readKitVersion(): string {
  // dist/opencli.js -> repo root is one level up (mirrors cli.ts / public-surface.ts).
  const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8")) as {
    version: string;
  };
  return pkg.version;
}

/**
 * Build the OpenCLI document from kit's live command surface. Top-level verbs
 * become commands; any COMMAND_HELP key containing a space (`"<verb> <sub>"`) is
 * nested under its parent, which is then marked `kind: "group"`. Deterministic and
 * pure apart from reading kit's own package.json version.
 */
export function buildOpenCliDoc(): OpenCliDoc {
  const mcp = new Set(KIT_MCP_TOOLS.map((t) => t.replace(/^kit_/, "")));

  const acceptedFlags = (verb: string): string[] | null => {
    const own = COMMAND_FLAGS[verb];
    if (!own) return null;
    return [...new Set([...own, ...GLOBAL_FLAGS])].sort();
  };

  const node = (name: string, kind: OpenCliCommand["kind"], flagVerb = name): OpenCliCommand => {
    const flags = acceptedFlags(flagVerb);
    return {
      kind,
      summary: COMMAND_HELP[name] ?? "",
      "x-kit-stability": COMMAND_TIERS[name] ?? "experimental",
      "x-kit-mcp": mcp.has(name),
      "x-kit-audience": COMMAND_AUDIENCE[name] ?? "all",
      "x-kit-args-modeled": flags !== null,
      ...(flags !== null ? { "x-kit-accepted-flags": flags } : {}),
    };
  };

  const commands: Record<string, OpenCliCommand> = {};
  for (const name of Object.keys(COMMANDS)) commands[name] = node(name, "command");

  // Attach subcommands from the "<verb> <sub>" help keys; promote parents to groups.
  for (const key of Object.keys(COMMAND_HELP)) {
    const sp = key.indexOf(" ");
    if (sp < 0) continue;
    const parent = key.slice(0, sp);
    const sub = key.slice(sp + 1);
    const parentNode = commands[parent];
    if (!parentNode) continue; // subcommand of an unknown/aliased verb — skip, never guess
    parentNode.kind = "group";
    const child = node(key, "command", parent);
    child["x-kit-stability"] = parentNode["x-kit-stability"];
    child["x-kit-audience"] = parentNode["x-kit-audience"];
    child["x-kit-mcp"] = false;
    (parentNode.commands ??= {})[sub] = child;
  }

  return {
    opencliVersion: OPENCLI_VERSION,
    info: {
      title: "kit",
      summary:
        "Deterministic, local-first developer-environment manager and fail-closed governance layer for AI agents and humans.",
      version: readKitVersion(),
      binary: "kit",
    },
    commands,
  };
}

/** Recursively sort object keys + primitive arrays so serialization is order-stable. */
function canonicalize(value: unknown): unknown {
  if (typeof value === "string") return value.replace(/\\/g, "/");
  if (Array.isArray(value)) {
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
 * Deterministic JSON for the OpenCLI snapshot: keys sorted, 2-space indent, LF
 * newlines, trailing newline — so the gen script and the golden test can do a
 * byte-for-byte compare on every OS (matches public-surface.ts discipline).
 */
export function serializeOpenCli(doc: OpenCliDoc): string {
  const json = JSON.stringify(canonicalize(doc), null, 2);
  return `${json.replace(/\r\n/g, "\n")}\n`;
}
