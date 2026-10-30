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

export const MAX_BYTES = 5 * 1024 * 1024; // 5 MiB

// Terraform / tfstate finding labels do not apply to build artifacts and
// false-positive on framework manifests. For example, Next.js `routes-manifest.json`
// has many `"value":"…"` route entries that match the tfstate `"value"` rule.
// A build-artifact leak is an inlined CREDENTIAL (sk_/JWT/AWS/…), not an HCL or
// state construct, so these labels are filtered out here.
const BUILD_IRRELEVANT_LABELS = new Set(["tfstate-value", "terraform-sensitive"]);
const BUILD_GENERIC_LABELS = new Set(["keyed-secret", "url-query-token"]);
const OPAQUE_MIN_LENGTH = 20;
const OPAQUE_MIN_ENTROPY = 4.2;
const MAX_MAP_SOURCES = 100_000;

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
type SourceBudget = { sources: number; nestedBytes: number };

// The complete JSON has already been validated. Skip a non-string array item
// while leaving it in the raw map for the normal scan.
function skipJsonValue(content: string, start: number, budget: SourceBudget): number {
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

function readSourceArray(
  content: string,
  start: number,
  budget: SourceBudget,
  findings: SecretFinding[],
): number | undefined {
  const strings = /"(?:\\.|[^"\\])*"/g;
  let cursor = start;
  let ordinary = true;
  while (true) {
    cursor += /^\s*/.exec(content.slice(cursor))![0].length;
    if (content[cursor] === "]") return ordinary ? cursor + 1 : undefined;
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
      ordinary = false;
      const end = skipJsonValue(content, cursor, budget);
      const normalized = content
        .slice(cursor, end)
        .replace(/"(?:\\.|[^"\\])*"/g, (token) => JSON.stringify(JSON.parse(token)));
      for (const finding of findBuildSecrets(normalized)) findings.push(finding);
      cursor = end;
    }
    cursor += /^\s*/.exec(content.slice(cursor))![0].length;
    if (content[cursor] === ",") cursor++;
    else if (content[cursor] !== "]") return undefined;
  }
}

// Scan decoded sources separately so escaped quotes cannot join unrelated code.
// Keep the original remaining JSON, including duplicate fields, for the scan.
export function findArtifactSecrets(content: string, file: string): SecretFinding[] {
  if (!file.endsWith(".map")) return findBuildSecrets(content);
  try {
    JSON.parse(content);
  } catch {
    return findBuildSecrets(content);
  }
  const findings: SecretFinding[] = [];
  const budget = { sources: 0, nestedBytes: 0 };
  const ranges: SourceRange[] = [];
  const strings = /"(?:\\.|[^"\\])*"/g;
  let token: RegExpExecArray | null;
  try {
    while ((token = strings.exec(content)) !== null) {
      if (JSON.parse(token[0]) !== "sourcesContent") continue;
      const prefix = /^\s*:\s*\[/.exec(content.slice(strings.lastIndex));
      if (!prefix) continue;
      const arrayStart = strings.lastIndex + prefix[0].length;
      const arrayEnd = readSourceArray(content, arrayStart, budget, findings);
      if (arrayEnd === undefined) continue;
      ranges.push({ start: arrayStart, end: arrayEnd - 1 });
      strings.lastIndex = arrayEnd;
    }
  } catch (error) {
    throw new ArtifactIncompleteError((error as Error).message, findings);
  }
  const rest: string[] = [];
  let from = 0;
  for (const range of ranges) {
    rest.push(content.slice(from, range.start));
    from = range.end;
  }
  rest.push(content.slice(from));
  return findings.concat(findBuildSecrets(rest.join("")));
}
