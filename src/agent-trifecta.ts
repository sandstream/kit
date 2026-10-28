/**
 * Lethal trifecta check for the agent setup.
 *
 * An agent that holds all three of these in one context can be steered by text it reads:
 *   vector  - it reads input an outsider can write (web pages, mail, issues, chat),
 *   payload - it can read private data (files, secrets, databases),
 *   egress  - it can send data out (web requests, network commands, chat posts).
 * Each leg is harmless alone. Removing one leg is the cheapest fix, and splitting the work over two
 * agents with different tools is the structural one.
 *
 * This reads only what is declared: permission rules and subagent tool lists. It never reads a value
 * from a config file and never runs anything. Classification of MCP servers is a guess from the
 * server name, so a server it cannot place is reported as unclassified, never passed.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SecurityCheckResult } from "./check-security.js";

export interface Legs {
  vector: string[];
  payload: string[];
  egress: string[];
  /** Grants the table could not place. */
  unknown: string[];
}

const NETWORK_COMMANDS = ["curl", "wget", "http", "nc", "ncat", "ssh", "scp", "rsync"];
const WEB_FAMILY = ["slack", "teams", "mail", "outlook", "discord", "github", "gitlab", "jira"]
  .concat(["atlassian", "confluence", "notion", "intercom", "zendesk", "browser", "chrome"])
  .concat(["playwright", "puppeteer", "fetch", "web", "search"]);
const DATA_FAMILY = [
  "supabase",
  "postgres",
  "sql",
  "mysql",
  "mongo",
  "database",
  "infisical",
].concat(["vault", "secret", "drive", "sharepoint", "gmail", "outlook", "notion", "s3"]);
const FILE_READERS = ["Read", "Grep", "Glob"];
const NOT_LEGS = ["Edit", "Write", "MultiEdit", "NotebookEdit", "TodoWrite", "Task", "Agent"];

const MAX_SHOWN = 80;

/** Text from a config file or a file name, safe to print: control characters out, length capped. */
export function shown(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code > 31 && (code < 127 || code > 159)) out += ch;
  }
  return out.slice(0, MAX_SHOWN);
}

function split(grant: string): { name: string; arg: string | null } {
  const open = grant.indexOf("(");
  if (open < 0 || !grant.endsWith(")")) return { name: grant, arg: null };
  return { name: grant.slice(0, open), arg: grant.slice(open + 1, -1).trim() };
}

function bashLegs(grant: string, arg: string | null, out: Legs): void {
  const first = (arg ?? "*").split(" ")[0].replace(":*", "");
  if (arg === null || first === "*" || first === "") {
    out.vector.push(grant);
    out.payload.push(grant);
    out.egress.push(grant);
  } else if (NETWORK_COMMANDS.includes(first)) {
    out.vector.push(grant);
    out.egress.push(grant);
  }
}

function readsPrivate(arg: string | null): boolean {
  if (arg === null || arg === "*" || arg === "**" || arg === "./**") return true;
  return arg.includes(".env") || arg.includes("~/") || arg.includes("secret");
}

function mcpLegs(grant: string, out: Legs): void {
  const server = grant.split("__")[1]?.toLowerCase() ?? "";
  const web = WEB_FAMILY.some((f) => server.includes(f));
  const data = DATA_FAMILY.some((f) => server.includes(f));
  if (web) {
    out.vector.push(grant);
    out.egress.push(grant);
  }
  if (data) out.payload.push(grant);
  if (!web && !data) out.unknown.push(grant);
}

/** The legs a set of grants holds, with the grants that hold each. Pure. */
export function legsOf(grants: string[]): Legs {
  const out: Legs = { vector: [], payload: [], egress: [], unknown: [] };
  for (const grant of grants) {
    const { name, arg } = split(grant);
    if (name === "*") {
      out.vector.push(grant);
      out.payload.push(grant);
      out.egress.push(grant);
    } else if (name === "WebFetch" || name === "WebSearch") {
      out.vector.push(grant);
      out.egress.push(grant);
    } else if (name === "Bash") bashLegs(grant, arg, out);
    else if (FILE_READERS.includes(name)) {
      if (readsPrivate(arg)) out.payload.push(grant);
    } else if (name.startsWith("mcp__")) mcpLegs(grant, out);
    else if (!NOT_LEGS.includes(name)) out.unknown.push(grant);
  }
  return out;
}

/** The `tools` field of an agent definition, or null when the file declares none (inherits all). */
export function parseAgentTools(markdown: string): string[] | null {
  if (!markdown.startsWith("---")) return null;
  const end = markdown.indexOf("\n---", 3);
  const lines = markdown.slice(3, end < 0 ? undefined : end).split("\n");
  const at = lines.findIndex((l) => l.startsWith("tools:"));
  if (at < 0) return null;
  const inline = lines[at].slice("tools:".length).trim();
  if (inline)
    return inline
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  const items: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (!l.trim().startsWith("- ")) break;
    items.push(l.trim().slice(2).trim());
  }
  return items;
}

function readJson(path: string): Record<string, unknown> {
  try {
    const v = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** The main session's grants from declared rules and the configured starting mode. */
function sessionPermissions(
  root: string,
  home: string,
): { grants: string[]; blocked: Set<string>; mode: string } {
  const allow: string[] = [];
  const deny: string[] = [];
  const ask: string[] = [];
  let mode = "default";
  for (const path of [
    join(home, ".claude", "settings.json"),
    join(root, ".claude", "settings.json"),
    join(root, ".claude", "settings.local.json"),
  ]) {
    const p = (readJson(path).permissions ?? {}) as Record<string, unknown>;
    allow.push(...strings(p.allow));
    deny.push(...strings(p.deny));
    ask.push(...strings(p.ask));
    if (typeof p.defaultMode === "string") mode = p.defaultMode;
  }
  const blocked = new Set([...deny, ...ask].filter((rule) => !rule.includes("(")));
  if (mode === "bypassPermissions") return { grants: ["*"], blocked, mode };
  if (mode === "acceptEdits") {
    allow.push("Edit", "Bash(mkdir *)", "Bash(touch *)", "Bash(mv *)", "Bash(cp *)");
  }
  return {
    grants: allow.filter((grant) => !blocked.has("*") && !blocked.has(split(grant).name)),
    blocked,
    mode,
  };
}

interface AgentFile {
  name: string;
  tools: string[] | null;
}

function agentFiles(dir: string): AgentFile[] {
  if (!existsSync(dir)) return [];
  const out: AgentFile[] = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".md"))) {
    try {
      out.push({
        name: f.slice(0, -3),
        tools: parseAgentTools(readFileSync(join(dir, f), "utf8")),
      });
    } catch {
      // unreadable agent file: skip, this check only reports what it can read
    }
  }
  return out;
}

const REMOVE_HINT: Record<string, string> = {
  egress: "remove the way out (WebFetch, network Bash, chat or mail send) from this agent",
  vector: "move the reading of outside text to a separate agent that has no way out",
  payload: "keep this agent away from private files and databases",
};

function writeGrants(grants: string[]): string[] {
  return grants.filter((grant) => {
    const { name, arg } = split(grant);
    const command = (arg ?? "").split(/[\s:]/)[0];
    const fileCommand = [
      "rm",
      "rmdir",
      "mv",
      "cp",
      "mkdir",
      "touch",
      "tee",
      "truncate",
      "install",
      "patch",
      "python",
      "python3",
      "node",
      "ruby",
      "perl",
      "sh",
      "bash",
    ].includes(command);
    return (
      name === "*" ||
      ["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(name) ||
      ((name === "Bash" || name === "PowerShell") &&
        (arg === null || arg === "*" || arg === "" || fileCommand))
    );
  });
}

function preapprovedWrites(grants: string[], blocked: Set<string>): string[] {
  const candidates = grants.includes("*") ? ["Edit", "Bash", "PowerShell"] : writeGrants(grants);
  return candidates.filter((grant) => !blocked.has("*") && !blocked.has(split(grant).name));
}

function writeRow(unit: string, grants: string[]): SecurityCheckResult | null {
  const writes = writeGrants(grants);
  if (!writes.length) return null;
  return {
    category: "exposure",
    name: `write access without confirmation: ${unit}`,
    status: "warn",
    severity: "medium",
    detail: `declared permissions allow writes without a prompt: ${writes.slice(0, 3).map(shown).join(", ")}`,
    suggestion: "remove the allow rule, change the permission mode, or add an ask rule for writes",
  };
}

function approvedAgentWrites(session: string[], tools: string[] | null): string[] {
  const allowed = writeGrants(session);
  if (tools === null || tools.includes("*")) return allowed;
  if (allowed.includes("*")) return writeGrants(tools);
  const toolNames = new Set(writeGrants(tools).map((grant) => split(grant).name));
  const fileTools = ["Edit", "Write", "MultiEdit", "NotebookEdit"];
  return allowed.filter((grant) => {
    const name = split(grant).name;
    return (
      toolNames.has(name) || (name === "Edit" && fileTools.some((tool) => toolNames.has(tool)))
    );
  });
}

function unitRow(unit: string, legs: Legs): SecurityCheckResult | null {
  if (!legs.vector.length || !legs.payload.length || !legs.egress.length) return null;
  const evidence = (g: string[]): string => [...new Set(g)].slice(0, 3).map(shown).join(", ");
  return {
    category: "exposure",
    name: `lethal trifecta: ${unit}`,
    status: "warn",
    severity: "medium",
    detail:
      `holds all three legs. untrusted input: ${evidence(legs.vector)}. ` +
      `private data: ${evidence(legs.payload)}. way out: ${evidence(legs.egress)}`,
    suggestion: `${REMOVE_HINT.egress}; or ${REMOVE_HINT.vector}. A sentence in a web page can then not reach your files.`,
  };
}

/** Separate rows for the trifecta and prompt-free writes, plus unknown grants or one pass row. */
export function runAgentTrifecta(root: string, home: string): SecurityCheckResult[] {
  const { grants: session, blocked, mode } = sessionPermissions(root, home);
  const approvedWrites = mode === "plan" ? [] : preapprovedWrites(session, blocked);
  const units: { unit: string; grants: string[]; approvedWrites: string[] }[] = [
    { unit: "main session", grants: session, approvedWrites },
  ];
  for (const a of [
    ...agentFiles(join(root, ".claude", "agents")),
    ...agentFiles(join(home, ".claude", "agents")),
  ]) {
    units.push({
      unit: `agent ${shown(a.name)}`,
      grants: a.tools ?? session,
      approvedWrites: approvedAgentWrites(approvedWrites, a.tools),
    });
  }
  const rows: SecurityCheckResult[] = [];
  const unknown = new Set<string>();
  for (const u of units) {
    const write = writeRow(u.unit, u.approvedWrites);
    if (write) rows.push(write);
    const legs = legsOf(u.grants);
    legs.unknown.forEach((g) => unknown.add(g));
    const row = unitRow(u.unit, legs);
    if (row) rows.push(row);
  }
  if (unknown.size > 0) {
    rows.push({
      category: "exposure",
      name: "lethal trifecta: unclassified grants",
      status: "warn",
      severity: "low",
      detail: `kit cannot place ${[...unknown].slice(0, 5).map(shown).join(", ")} as input, private data or way out, so it counts none of them`,
      suggestion: "check by hand whether any of these reads outside text or sends data out",
    });
  }
  if (rows.length === 0) {
    rows.push({
      category: "exposure",
      name: "lethal trifecta",
      status: "pass",
      detail: `no agent holds untrusted input, private data and a way out together in the declared grants (${units.length} unit(s) checked). Approvals and auto mode decided at run time are not visible here`,
    });
  }
  return rows;
}
