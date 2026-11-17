/**
 * Whether one agent tool call that carries an identity value would send it over the network,
 * and to which host. Pure: reads the tool name and its input, never runs or fetches anything.
 *
 * Network-shaped means: a tool that reaches the network by itself (`WebFetch`, `WebSearch`, any
 * `mcp__` tool), or an input that names a network client or request part (`curl`, `wget`, an
 * `http(s)://` URL, a `User-Agent` or `From` header, `fetch(`, Python `requests` or `urllib`).
 */

/** Tools that reach the network on every call. */
const NETWORK_TOOLS = new Set(["WebFetch", "WebSearch"]);

/** Network clients and request parts, as they appear in a command or a script. */
const NETWORK_TEXT = [
  /\bcurl\b/i,
  /\bwget\b/i,
  /\bhttps?:\/\//i,
  /\buser-agent\b/i,
  /(^|["'\s])from\s*:/im,
  /\bfetch\s*\(/,
  /\brequests\.(get|post|put|patch|delete|request|session)\b/,
  /\burllib\b/,
  /\bInvoke-(WebRequest|RestMethod)\b/i,
];

const URL_PATTERN = /\bhttps?:\/\/[^\s"'<>\\`]+/gi;

export interface ToolCallClass {
  network: boolean;
  /** The destination for a network-shaped call: a host, `mcp:<server>`, `web-search` or `unknown`. */
  host: string | null;
}

/** The host of the first parseable `http(s)://` URL in a text, lower-cased; null when none. */
export function firstUrlHost(text: string): string | null {
  for (const m of text.matchAll(URL_PATTERN)) {
    try {
      const host = new URL(m[0]).hostname.toLowerCase();
      if (host) return host;
    } catch {
      /* not a URL after all; try the next one */
    }
  }
  return null;
}

/** The MCP server a `mcp__<server>__<tool>` name calls. */
function mcpServer(tool: string): string {
  const rest = tool.slice("mcp__".length);
  const end = rest.indexOf("__");
  return end > 0 ? rest.slice(0, end) : rest;
}

/** Classify one tool call. `inputText` is the call's input serialized as JSON. */
export function classifyToolCall(tool: string, inputText: string): ToolCallClass {
  if (tool.startsWith("mcp__")) return { network: true, host: `mcp:${mcpServer(tool)}` };
  if (tool === "WebSearch") return { network: true, host: "web-search" };
  const urlHost = firstUrlHost(inputText);
  if (NETWORK_TOOLS.has(tool)) return { network: true, host: urlHost ?? "unknown" };
  // JSON escapes newlines in the serialized input; undo that so `^From:` can match a line.
  const text = inputText.replace(/\\n/g, "\n");
  if (!NETWORK_TEXT.some((re) => re.test(text))) return { network: false, host: null };
  return { network: true, host: urlHost ?? "unknown" };
}
