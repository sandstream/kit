/**
 * kit memory — transcript content flattening shared by the harness parsers.
 *
 * Lives apart from parser.ts so a harness parser (droid.ts) can use it without importing parser.ts,
 * which imports every harness parser: that pair was a load-time import cycle.
 */

export interface ContentBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: unknown;
}
export type Content = string | ContentBlock[] | undefined;

/** Flatten transcript content (string or block array) into searchable plain text. */
export function extractText(content: Content): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (b?.type === "text") return b.text ?? "";
        if (b?.type === "tool_use") return `[Tool: ${b.name ?? "unknown"}]`;
        if (b?.type === "tool_result") return "[Tool Result]";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}
