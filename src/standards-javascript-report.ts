import { createHash } from "node:crypto";
import type { ComplexityFinding } from "./check-standards.js";
import type { JavaScriptInput } from "./standards-javascript-files.js";

export const JAVASCRIPT_METRIC_VERSION = "kit-js-ccn/v1";
export const TYPESCRIPT_TOOL_VERSIONS = new Set(["5.9.3", "6.0.3"]);

type ObjectValue = Record<string, unknown>;
function object(value: unknown): value is ObjectValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function position(value: unknown, limit: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= limit;
}

function bodyIdentity(body: ObjectValue, ids: Set<string>) {
  if (
    typeof body.id !== "string" ||
    !body.id ||
    ids.has(body.id) ||
    typeof body.name !== "string" ||
    !body.name ||
    !["function", "module", "initializer", "static-block"].includes(String(body.kind))
  ) {
    throw new Error("JavaScript parser returned an invalid body identity");
  }
  ids.add(body.id);
  return { identity: body.id, fn: body.name, kind: body.kind as ComplexityFinding["kind"] };
}

function lineStarts(text: string): number[] {
  const starts = [0];
  // CRLF occupies one line boundary. Offsets remain UTF-16 code units.
  for (const match of text.matchAll(/\r\n|[\r\n\u2028\u2029]/g)) {
    starts.push(match.index + match[0].length);
  }
  return starts;
}

function lineAt(starts: number[], offset: number): number {
  let low = 0;
  let high = starts.length;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (starts[middle] <= offset) low = middle;
    else high = middle;
  }
  return low;
}

function bodySpan(body: ObjectValue, source: JavaScriptInput, starts: number[]) {
  const { start, end } = body;
  if (!position(start, source.text.length) || !position(end, source.text.length) || end < start) {
    throw new Error("JavaScript parser returned an invalid body span");
  }
  if (body.kind === "module") {
    if (start !== 0 || end !== source.text.length) {
      throw new Error("JavaScript parser did not cover the complete source");
    }
  } else if (start === end) {
    throw new Error("JavaScript parser returned an empty executable body");
  }
  const length = lineAt(starts, Math.max(start, end - 1)) - lineAt(starts, start) + 1;
  if (body.length !== length) throw new Error("JavaScript parser returned an invalid body length");
  return { start, end, length };
}

function decisionCount(decisions: unknown, start: number, end: number): number {
  if (
    !Array.isArray(decisions) ||
    !decisions.every((value) => position(value, end - 1) && value >= start) ||
    new Set(decisions).size !== decisions.length
  ) {
    throw new Error("JavaScript parser returned invalid body decisions");
  }
  return decisions.length + 1;
}

function bodyFinding(
  body: unknown,
  source: JavaScriptInput,
  ids: Set<string>,
  starts: number[],
): ComplexityFinding {
  if (!object(body)) throw new Error("JavaScript parser returned an invalid body measurement");
  const identity = bodyIdentity(body, ids);
  const { start, end, length } = bodySpan(body, source, starts);
  const ccn = decisionCount(body.decisions, start, end);
  if (body.ccn !== ccn) throw new Error("JavaScript parser returned an invalid body complexity");
  return {
    file: source.path,
    ...identity,
    ccn,
    length,
    metricVersion: JAVASCRIPT_METRIC_VERSION,
  };
}

/**
 * A source offset moves when text above the body changes, so it cannot be the baseline
 * identity. The anchor is kind, name and the body's order among bodies of that kind and name.
 */
function anchorBodies(bodies: ObjectValue[], findings: ComplexityFinding[], text: string): void {
  const order = findings
    .map((finding, index) => ({ finding, start: bodies[index].start as number }))
    .sort((a, b) => a.start - b.start);
  const seen = new Map<string, number>();
  for (const { finding, start } of order) {
    const label = `${finding.kind}:${anchorName(finding.fn, text, start)}`;
    const nth = seen.get(label) ?? 0;
    seen.set(label, nth + 1);
    finding.anchor = `${label}#${nth}`;
  }
}

/**
 * The worker names an anonymous body by its offset, which the anchor must not carry. The text
 * before the body on its own line (for a callback: the call and its title) names it instead.
 */
function anchorName(fn: string, text: string, start: number): string {
  if (!/^\(anonymous@\d+\)$/.test(fn)) return fn;
  const lineStart =
    Math.max(text.lastIndexOf("\n", start - 1), text.lastIndexOf("\r", start - 1)) + 1;
  const context = text.slice(lineStart, start).trim().replace(/\s+/g, " ").slice(-80);
  // A digest, so that no source text enters the baseline file or a report.
  return `(anonymous)<${createHash("sha256").update(context).digest("hex").slice(0, 12)}>`;
}

function fileFindings(file: unknown, expected: Map<string, JavaScriptInput>): ComplexityFinding[] {
  if (!object(file) || typeof file.path !== "string") throw new Error("Invalid source report");
  const source = expected.get(file.path);
  if (
    !source ||
    file.sha256 !== source.sha256 ||
    file.status !== "complete" ||
    !Array.isArray(file.diagnostics) ||
    file.diagnostics.length ||
    !Array.isArray(file.bodies)
  ) {
    throw new Error("JavaScript parser omitted or rejected a source input");
  }
  const modules = file.bodies.filter((body) => object(body) && body.kind === "module");
  if (modules.length !== 1)
    throw new Error("JavaScript parser must return exactly one source module");
  const starts = lineStarts(source.text);
  const ids = new Set<string>();
  const findings = file.bodies.map((body) => bodyFinding(body, source, ids, starts));
  anchorBodies(file.bodies as ObjectValue[], findings, source.text);
  expected.delete(file.path);
  return findings;
}

export function readJavaScriptReport(
  text: string,
  inputs: JavaScriptInput[],
  compilerVersion: string,
): ComplexityFinding[] {
  const report: unknown = JSON.parse(text);
  if (
    !object(report) ||
    report.version !== 1 ||
    report.complete !== true ||
    report.calibration !== true ||
    report.metricVersion !== JAVASCRIPT_METRIC_VERSION ||
    !object(report.engine) ||
    report.engine.name !== "typescript" ||
    report.engine.version !== compilerVersion ||
    !TYPESCRIPT_TOOL_VERSIONS.has(compilerVersion) ||
    !Array.isArray(report.files) ||
    report.files.length !== inputs.length
  ) {
    throw new Error("JavaScript parser did not produce a complete supported report");
  }
  const expected = new Map(inputs.map((input) => [input.path, input]));
  const findings: ComplexityFinding[] = [];
  for (const file of report.files) {
    findings.push(...fileFindings(file, expected));
  }
  if (expected.size) throw new Error("JavaScript parser omitted a source input");
  return findings;
}
