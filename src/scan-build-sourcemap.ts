import {
  findSecretMatches,
  SECRET_PATTERNS,
  shannonEntropy,
  type SecretMatch,
} from "./utils/redactSecrets.js";

import {
  findingEvidenceSchema,
  locateSecretMatches,
  type EvidencedSecret,
} from "./finding-evidence.js";

export class ArtifactIncompleteError extends Error {
  constructor(
    message: string,
    readonly findings: EvidencedSecret[],
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
const UNSAFE_RAW_LABELS = new Set([
  ...BUILD_GENERIC_LABELS,
  "pem-private-key",
  "gcp-private-key",
  "url-credentials",
]);
const OPAQUE_MIN_LENGTH = 20;
const OPAQUE_MIN_ENTROPY = 4.2;

export function findBuildMatches(content: string): SecretMatch[] {
  const findings = findSecretMatches(content).filter(
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
      findings.push({ label, preview: "[REDACTED]", offset: match.index });
    }
  }

  return findings;
}

function lineAt(text: string): (offset: number) => number {
  const starts = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  return (offset) => {
    let from = 0;
    let to = starts.length;
    while (from + 1 < to) {
      const mid = Math.floor((from + to) / 2);
      if (starts[mid] <= offset) from = mid;
      else to = mid;
    }
    return from + 1;
  };
}

type ScanToken = (text: string, offset: number) => void;

/** A decoded match lies inside one JSON string token on the physical map line. */
function scanMapToken(content: string, file: string, findings: EvidencedSecret[]): ScanToken {
  let locate: ((offset: number) => number) | undefined;
  return (text, tokenOffset) => {
    for (const { label, preview } of findBuildMatches(text)) {
      locate ??= lineAt(content);
      const evidence = findingEvidenceSchema.parse({
        file,
        line: locate(tokenOffset),
        pattern: label,
      });
      findings.push({ label, preview, evidence });
    }
  };
}

type SourceRange = { start: number; end: number };

function readSourceArray(
  content: string,
  start: number,
  budget: SourceBudget,
  scan: ScanToken,
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
        scan(decoded, cursor);
      }
      cursor = strings.lastIndex;
    } else if (content.startsWith("null", cursor)) {
      cursor += 4;
    } else {
      budget.malformed = true;
      const end = skipJsonValue(content, cursor, budget);
      scanMalformedObject(content.slice(cursor, end), budget, (text, offset) =>
        scan(text, cursor + offset),
      );
      cursor = end;
    }
    cursor += /^\s*/.exec(content.slice(cursor))![0].length;
    if (content[cursor] === ",") cursor++;
    else if (content[cursor] !== "]") return undefined;
  }
}

function scanSourceValue(
  content: string,
  start: number,
  budget: SourceBudget,
  scan: ScanToken,
): number | undefined {
  const first = content[start];
  if (first === "[") return readSourceArray(content, start + 1, budget, scan);
  budget.malformed = true;
  const end = skipJsonValue(content, start, budget);
  const value = content.slice(start, end);
  if (first === '"') scan(JSON.parse(value) as string, start);
  if (first === "{")
    scanMalformedObject(value, budget, (text, offset) => scan(text, start + offset));
  return end;
}

function scanMapMetadata(content: string, scan: ScanToken): void {
  const strings = /"(?:\\.|[^"\\])*"/g;
  const ranges: SourceRange[] = [];
  const budget: SourceBudget = { sources: 0, nestedBytes: 0, malformed: false, ambiguous: false };
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
    rest.push(
      content.slice(from, range.start),
      content.slice(range.start, range.end).replace(/[^\n]/g, " "),
    );
    from = range.end;
  }
  rest.push(content.slice(from));
  scanMalformedObject(rest.join(""), budget, scan);
  if (budget.ambiguous) throw new Error("source map contains an ambiguous keyed value");
}

function reportInvalidMap(content: string, file: string): never {
  // Raw provider patterns can still match a source string cut off mid-value.
  // Generic key patterns need decoded delimiters and are scanned below.
  const raw = locateSecretMatches(
    file,
    content,
    findBuildMatches(content).filter((finding) => !UNSAFE_RAW_LABELS.has(finding.label)),
  );
  const findings: EvidencedSecret[] = [];
  try {
    scanMalformedObject(
      content,
      { sources: 0, nestedBytes: 0, malformed: true, ambiguous: false },
      scanMapToken(content, file, findings),
    );
  } catch {
    // The incomplete result still reports findings collected before an invalid token or limit.
  }
  const seen = new Set(findings.map((finding) => `${finding.label}\0${finding.preview}`));
  for (const finding of raw) {
    const key = `${finding.label}\0${finding.preview}`;
    if (!seen.has(key)) findings.push(finding);
    seen.add(key);
  }
  throw new ArtifactIncompleteError("source map has invalid JSON", findings);
}

// Scan decoded sources separately so escaped quotes cannot join unrelated code.
// Keep the original remaining JSON, including duplicate fields, for the scan.
export function findArtifactSecrets(content: string, file: string): EvidencedSecret[] {
  if (!file.endsWith(".map")) return locateSecretMatches(file, content, findBuildMatches(content));
  try {
    const map: unknown = JSON.parse(content);
    if (!map || typeof map !== "object" || Array.isArray(map))
      throw new Error("invalid source map");
  } catch {
    reportInvalidMap(content, file);
  }
  const findings: EvidencedSecret[] = [];
  const scan = scanMapToken(content, file, findings);
  const budget: SourceBudget = { sources: 0, nestedBytes: 0, malformed: false, ambiguous: false };
  const strings = /"(?:\\.|[^"\\])*"/g;
  let token: RegExpExecArray | null;
  try {
    while ((token = strings.exec(content)) !== null) {
      if (JSON.parse(token[0]) !== "sourcesContent") continue;
      const prefix = /^\s*:\s*/.exec(content.slice(strings.lastIndex));
      if (!prefix) continue;
      const valueStart = strings.lastIndex + prefix[0].length;
      const end = scanSourceValue(content, valueStart, budget, scan);
      if (end !== undefined) strings.lastIndex = end;
    }
  } catch (error) {
    try {
      scanMapMetadata(content, scan);
    } catch {
      // The incomplete result still reports findings collected before the metadata limit.
    }
    throw new ArtifactIncompleteError((error as Error).message, findings);
  }
  try {
    scanMapMetadata(content, scan);
  } catch (error) {
    throw new ArtifactIncompleteError((error as Error).message, findings);
  }
  if (budget.malformed) {
    throw new ArtifactIncompleteError("source map has invalid source content", findings);
  }
  if (budget.ambiguous) {
    throw new ArtifactIncompleteError("source map contains an ambiguous keyed value", findings);
  }
  return findings;
}
