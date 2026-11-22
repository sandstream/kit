type JsonIssue = {
  code: "invalid-utf8" | "invalid-json" | "duplicate-json-key" | "input-limit" | "invalid-schema";
  message: string;
};

export type JsonObjectResult = { value: Record<string, unknown> } | { issues: JsonIssue[] };

/** Parse JSON data with unambiguous object keys and bounded nesting. */
export function parseJsonObject(bytes: Uint8Array, maxBytes: number): JsonObjectResult {
  if (bytes.byteLength > maxBytes) {
    return {
      issues: [
        {
          code: "input-limit",
          message: `Each input is limited to ${maxBytes / (1024 * 1024)} MiB.`,
        },
      ],
    };
  }
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { issues: [{ code: "invalid-utf8", message: "Input is not valid UTF-8." }] };
  }
  let value: unknown;
  try {
    const issues = objectKeyIssues(content);
    if (issues.length > 0) return { issues };
    value = JSON.parse(content);
  } catch {
    return { issues: [{ code: "invalid-json", message: "Expected a JSON document." }] };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { issues: [{ code: "invalid-schema", message: "Expected a JSON object." }] };
  }
  return { value: value as Record<string, unknown> };
}

function objectKeyIssues(content: string): JsonIssue[] {
  const stack: (Set<string> | null)[] = [];
  const issues: JsonIssue[] = [];
  const tokens = /("(?:[^"\\]|\\[\s\S])*")\s*(:)?|[{}[\]]/g;
  for (const token of content.matchAll(tokens)) {
    const char = token[0];
    if (char === "{" || char === "[") {
      stack.push(char === "{" ? new Set() : null);
      if (stack.length > 128) {
        issues.push({ code: "input-limit", message: "JSON nesting is limited to 128 levels." });
        return issues;
      }
    } else if (char === "}" || char === "]") {
      stack.pop();
    } else if (token[2]) {
      const keys = stack.at(-1);
      const key: string = JSON.parse(token[1]);
      if (keys?.has(key)) {
        issues.push({
          code: "duplicate-json-key",
          message: "Duplicate object keys make the input ambiguous.",
        });
      }
      keys?.add(key);
    }
  }
  return issues;
}
