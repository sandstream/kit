import { SECRET_PATTERNS, type SecretFinding } from "./utils/redactSecrets.js";
import { MAX_MAP_SOURCES, type SourceBudget } from "./scan-build-json.js";

export function scanMalformedObject(
  content: string,
  findings: SecretFinding[],
  budget: SourceBudget,
  scan: (value: string) => SecretFinding[],
): void {
  for (const token of content.matchAll(/"(?:\\.|[^"\\])*"/g)) {
    budget.sources++;
    if (budget.sources > MAX_MAP_SOURCES) {
      throw new Error("source map exceeds 100000 source entries; scan could not finish");
    }
    const decoded = JSON.parse(token[0]) as string;
    const valueToken = /^\s*:\s*("(?:\\.|[^"\\])*")/.exec(
      content.slice(token.index! + token[0].length),
    );
    if (valueToken) {
      const value = JSON.parse(valueToken[1]) as string;
      const probe = `${JSON.stringify(decoded)}:"${"A".repeat(20)}"`;
      const keyed = SECRET_PATTERNS.some(
        ({ label, re }) => label === "keyed-secret" && new RegExp(re.source, re.flags).test(probe),
      );
      if (keyed) {
        for (const finding of scan(`${JSON.stringify(decoded)}:${JSON.stringify(value)}`))
          findings.push(finding);
      }
    }
    if (decoded.length < 8) continue;
    for (const finding of scan(decoded)) findings.push(finding);
  }
}
