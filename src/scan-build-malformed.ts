import type { SecretFinding } from "./utils/redactSecrets.js";
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
    if (decoded.length < 8) continue;
    for (const finding of scan(decoded)) findings.push(finding);
  }
}
