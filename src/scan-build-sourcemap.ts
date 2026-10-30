import {
  findSecrets,
  SECRET_PATTERNS,
  shannonEntropy,
  type SecretFinding,
} from "./utils/redactSecrets.js";

export class ArtifactIncompleteError extends Error {
  constructor(
    message: string,
    readonly findings: SecretFinding[],
  ) {
    super(message);
  }
}

import { MAX_MAP_SOURCES, skipJsonValue, type SourceBudget } from "./scan-build-json.js";
import { scanMalformedObject } from "./scan-build-malformed.js";
export { MAX_BYTES } from "./scan-build-json.js";

// Terraform / tfstate finding labels do not apply to build artifacts and
// false-positive on framework manifests. For example, Next.js `routes-manifest.json`
// has many `"value":"…"` route entries that match the tfstate `"value"` rule.
// A build-artifact leak is an inlined CREDENTIAL (sk_/JWT/AWS/…), not an HCL or
// state construct, so these labels are filtered out here.
const BUILD_IRRELEVANT_LABELS = new Set(["tfstate-value", "terraform-sensitive"]);
const BUILD_GENERIC_LABELS = new Set(["keyed-secret", "url-query-token"]);
const OPAQUE_MIN_LENGTH = 20;
const OPAQUE_MIN_ENTROPY = 4.2;

function findBuildSecrets(content: string): SecretFinding[] {
  const findings = findSecrets(content).filter(
    (finding) =>
      !BUILD_IRRELEVANT_LABELS.has(finding.label) && !BUILD_GENERIC_LABELS.has(finding.label),
  );

  // Minified UI code routinely contains ordinary property names and example URLs.
  // Generic names only justify a build failure when their values look opaque.
  for (const { re, label } of SECRET_PATTERNS) {
    if (!BUILD_GENERIC_LABELS.has(label)) continue;
    for (const match of content.matchAll(new RegExp(re.source, re.flags))) {
      const value =
        label === "keyed-secret" ? (match[3] ?? match[2]) : match[0].slice(match[1].length);
      if (value.length < OPAQUE_MIN_LENGTH || shannonEntropy(value) < OPAQUE_MIN_ENTROPY) continue;
      findings.push({ label, preview: "[REDACTED]" });
    }
  }

  return findings;
}

type SourceRange = { start: number; end: number };

function readSourceArray(
  content: string,
  start: number,
  budget: SourceBudget,
  findings: SecretFinding[],
): number | undefined {
  const strings = /"(?:\\.|[^"\\])*"/g;
  let cursor = start;
  while (true) {
    cursor += /^\s*/.exec(content.slice(cursor))![0].length;
    if (content[cursor] === "]") return cursor + 1;
    budget.sources++;
    if (budget.sources > MAX_MAP_SOURCES) {
      throw new Error("source map exceeds 100000 source entries; scan could not finish");
    }
    if (content[cursor] === '"') {
      strings.lastIndex = cursor;
      const source = strings.exec(content)!;
      const decoded = JSON.parse(source[0]) as string;
      // No current credential or personal-number pattern can match fewer than eight characters.
      if (decoded.length >= 8) {
        for (const finding of findBuildSecrets(decoded)) findings.push(finding);
      }
      cursor = strings.lastIndex;
    } else if (content.startsWith("null", cursor)) {
      cursor += 4;
    } else {
      budget.malformed = true;
      const end = skipJsonValue(content, cursor, budget);
      scanMalformedObject(content.slice(cursor, end), findings, budget, findBuildSecrets);
      cursor = end;
    }
    cursor += /^\s*/.exec(content.slice(cursor))![0].length;
    if (content[cursor] === ",") cursor++;
    else if (content[cursor] !== "]") return undefined;
  }
}

function scanMapMetadata(content: string, findings: SecretFinding[]): void {
  const strings = /"(?:\\.|[^"\\])*"/g;
  const ranges: SourceRange[] = [];
  const budget: SourceBudget = { sources: 0, nestedBytes: 0, malformed: false };
  let token: RegExpExecArray | null;
  while ((token = strings.exec(content)) !== null) {
    if (JSON.parse(token[0]) !== "sourcesContent") continue;
    const prefix = /^\s*:\s*/.exec(content.slice(strings.lastIndex));
    if (!prefix) continue;
    const start = strings.lastIndex + prefix[0].length;
    const end = skipJsonValue(content, start, budget);
    ranges.push({ start, end });
    strings.lastIndex = end;
  }
  const rest: string[] = [];
  let from = 0;
  for (const range of ranges) {
    rest.push(content.slice(from, range.start), "null");
    from = range.end;
  }
  rest.push(content.slice(from));
  scanMalformedObject(rest.join(""), findings, budget, findBuildSecrets);
}

// Scan decoded sources separately so escaped quotes cannot join unrelated code.
// Keep the original remaining JSON, including duplicate fields, for the scan.
export function findArtifactSecrets(content: string, file: string): SecretFinding[] {
  if (!file.endsWith(".map")) return findBuildSecrets(content);
  try {
    JSON.parse(content);
  } catch {
    const findings: SecretFinding[] = [];
    try {
      scanMalformedObject(
        content,
        findings,
        { sources: 0, nestedBytes: 0, malformed: true },
        findBuildSecrets,
      );
    } catch {
      // The incomplete result still reports findings collected before an invalid token or limit.
    }
    throw new ArtifactIncompleteError("source map has invalid JSON", findings);
  }
  const findings: SecretFinding[] = [];
  const budget: SourceBudget = { sources: 0, nestedBytes: 0, malformed: false };
  const strings = /"(?:\\.|[^"\\])*"/g;
  let token: RegExpExecArray | null;
  try {
    while ((token = strings.exec(content)) !== null) {
      if (JSON.parse(token[0]) !== "sourcesContent") continue;
      const prefix = /^\s*:\s*/.exec(content.slice(strings.lastIndex));
      if (!prefix) continue;
      const valueStart = strings.lastIndex + prefix[0].length;
      if (content[valueStart] !== "[") {
        budget.malformed = true;
        const end = skipJsonValue(content, valueStart, budget);
        if (content[valueStart] === '"') {
          const decoded = JSON.parse(content.slice(valueStart, end)) as string;
          findBuildSecrets(decoded).forEach((finding) => findings.push(finding));
        } else if (content[valueStart] === "{") {
          scanMalformedObject(content.slice(valueStart, end), findings, budget, findBuildSecrets);
        }
        strings.lastIndex = end;
        continue;
      }
      const arrayStart = valueStart + 1;
      const arrayEnd = readSourceArray(content, arrayStart, budget, findings);
      if (arrayEnd === undefined) continue;
      strings.lastIndex = arrayEnd;
    }
  } catch (error) {
    try {
      scanMapMetadata(content, findings);
    } catch {
      // The incomplete result still reports findings collected before the metadata limit.
    }
    throw new ArtifactIncompleteError((error as Error).message, findings);
  }
  try {
    scanMapMetadata(content, findings);
  } catch (error) {
    throw new ArtifactIncompleteError((error as Error).message, findings);
  }
  if (budget.malformed) {
    throw new ArtifactIncompleteError("source map has invalid source content", findings);
  }
  return findings;
}
