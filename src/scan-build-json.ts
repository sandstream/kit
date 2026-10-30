export const MAX_BYTES = 5 * 1024 * 1024; // 5 MiB
export const MAX_MAP_SOURCES = 100_000;

export type SourceBudget = { sources: number; nestedBytes: number; malformed: boolean };

// The complete JSON has already been validated. Skip a non-string array item
// while leaving it in the raw map for the normal scan.
export function skipJsonValue(content: string, start: number, budget: SourceBudget): number {
  if (content[start] === '"') {
    const strings = /"(?:\\.|[^"\\])*"/g;
    strings.lastIndex = start;
    const value = strings.exec(content);
    if (!value || value.index !== start) throw new Error("Invalid source map string");
    return strings.lastIndex;
  }
  if (content[start] !== "{" && content[start] !== "[") {
    const scalar = /^(?:null|true|false|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
      content.slice(start),
    );
    if (!scalar) throw new Error("Invalid source map value");
    return start + scalar[0].length;
  }
  const tokens = /"(?:\\.|[^"\\])*"|[{}[\]]/g;
  tokens.lastIndex = start;
  let depth = 0;
  let previous = start;
  let token: RegExpExecArray | null;
  while ((token = tokens.exec(content)) !== null) {
    budget.nestedBytes += tokens.lastIndex - previous;
    previous = tokens.lastIndex;
    if (budget.nestedBytes > MAX_BYTES) {
      throw new Error("source map nesting exceeds scan work limit");
    }
    if (token[0] === "{" || token[0] === "[") depth++;
    else if (token[0] === "}" || token[0] === "]") depth--;
    if (depth === 0) return tokens.lastIndex;
  }
  throw new Error("Unclosed source map value");
}
