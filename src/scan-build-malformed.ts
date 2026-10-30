import { SECRET_PATTERNS, shannonEntropy, type SecretFinding } from "./utils/redactSecrets.js";
import { MAX_MAP_SOURCES, type SourceBudget } from "./scan-build-json.js";

function* jsonStringTokens(content: string): Generator<{ index: number; text: string }> {
  let cursor = 0;
  while (cursor < content.length) {
    const start = content.indexOf('"', cursor);
    if (start < 0) return;
    cursor = start + 1;
    let closed = false;
    while (cursor < content.length) {
      if (content[cursor] === "\\") cursor += 2;
      else if (content[cursor++] === '"') {
        closed = true;
        break;
      }
    }
    if (!closed) {
      // Try the unfinished string as a partial JSON value. Invalid trailing
      // escapes remain incomplete and are rejected by JSON.parse below.
      yield { index: start, text: content.slice(start) + '"' };
      return;
    }
    yield { index: start, text: content.slice(start, cursor) };
  }
}

export function scanMalformedObject(
  content: string,
  findings: SecretFinding[],
  budget: SourceBudget,
  scan: (value: string) => SecretFinding[],
): void {
  for (const token of jsonStringTokens(content)) {
    budget.sources++;
    if (budget.sources > MAX_MAP_SOURCES) {
      throw new Error("source map exceeds 100000 source entries; scan could not finish");
    }
    let decoded: string;
    try {
      decoded = JSON.parse(token.text) as string;
    } catch {
      continue;
    }
    const valueToken = /^\s*:\s*("(?:\\.|[^"\\])*")/.exec(
      content.slice(token.index + token.text.length),
    );
    if (valueToken) {
      let value: string;
      try {
        value = JSON.parse(valueToken[1]) as string;
      } catch {
        continue;
      }
      const probe = `${JSON.stringify(decoded)}:"${"A".repeat(20)}"`;
      const keyed = SECRET_PATTERNS.some(
        ({ label, re }) => label === "keyed-secret" && new RegExp(re.source, re.flags).test(probe),
      );
      if (keyed && /[\s"'\\]/.test(value) && value.length >= 20 && shannonEntropy(value) >= 4.2) {
        budget.ambiguous = true;
      }
      if (keyed && !/[\s"'\\]/.test(value)) {
        for (const finding of scan(`${JSON.stringify(decoded)}:${JSON.stringify(value)}`))
          findings.push(finding);
      }
    }
    if (decoded.length < 8) continue;
    for (const finding of scan(decoded)) findings.push(finding);
  }
}
