/**
 * kit coverage — generic evidence-map engine for ANY pinned standard.
 *
 * `coverage.ts` grew up ASVS-specific; this is the same proven idea generalized so
 * kit can map its deterministic checks against additional standards (OWASP LLM Top 10,
 * NIST SSDF) without duplicating the bucketing/evidence logic. A `StandardDescriptor`
 * bundles a pinned requirement list + a control→kit mapping; `buildStandardReport`
 * turns it into the same evidence map (auto / gap / manual / na) with the same honest
 * "not a compliance attestation" disclaimer.
 *
 * Pure + deterministic (data → report). Reuses coverage.ts's evidence primitives so
 * the two share one meaning of "verified/failing/unrun".
 */
import { evidenceFor, indexResults, citationsFor, type Bucket, type EvidenceState } from "./coverage.js";
import type { RuleRef } from "../rules/catalog.js";
import type { SecurityCheckResult } from "../check-security.js";

export interface StandardRequirement {
  /** Control id, e.g. "LLM01:2025" or "PW.4". */
  id: string;
  /** Section/group label for grouping, e.g. "LLM Application Risks" or "PW Produce Well-Secured Software". */
  section: string;
  /** Short paraphrase for orientation (NOT the normative text). */
  text: string;
}

export interface StandardMappingEntry {
  bucket: Bucket;
  /** kit evidence ids backing the control (check names / self-audit rule ids / commands). Empty for manual/na. */
  checks: string[];
  /** Honest, specific reason for the bucket. */
  rationale: string;
}

export interface StandardDescriptor {
  /** CLI selector, e.g. "llm-top10" or "ssdf". */
  key: string;
  /** Human label for headers, e.g. "OWASP Top 10 for LLM Applications". */
  label: string;
  /** Pinned version, e.g. "2025" or "800-218 v1.1 / 218A". */
  version: string;
  /** Full source name. */
  source: string;
  /** Canonical, version-pinned source URL. */
  sourceUrl: string;
  /** Word for a control in this standard ("risk", "practice", "control"). */
  unit: string;
  /** Extra honesty line appended to the disclaimer (caveats specific to this map). */
  caveat?: string;
  requirements: readonly StandardRequirement[];
  mapping: Record<string, StandardMappingEntry>;
}

export interface StandardEntry {
  requirement: StandardRequirement;
  bucket: Bucket;
  checks: string[];
  rationale: string;
  citations: RuleRef[];
  evidence?: EvidenceState;
}

export interface StandardSummary {
  total: number;
  auto: number;
  gap: number;
  manual: number;
  na: number;
  autoVerified?: number;
  autoFailing?: number;
  autoUnrun?: number;
}

export interface StandardReport {
  key: string;
  label: string;
  version: string;
  source: string;
  sourceUrl: string;
  disclaimer: string;
  summary: StandardSummary;
  sections: { section: string; entries: StandardEntry[] }[];
}

/** Build the flat entry list in descriptor order. Throws on an unmapped requirement. */
export function buildStandardEntries(
  descriptor: StandardDescriptor,
  byKey?: Map<string, SecurityCheckResult["status"]>,
): StandardEntry[] {
  return descriptor.requirements.map((requirement) => {
    const mapping = descriptor.mapping[requirement.id];
    if (!mapping) {
      throw new Error(
        `coverage: ${descriptor.key} ${requirement.id} is in the requirement list but has no mapping`,
      );
    }
    return {
      requirement,
      bucket: mapping.bucket,
      checks: [...mapping.checks],
      rationale: mapping.rationale,
      citations: citationsFor(mapping.checks),
      ...(byKey && mapping.bucket === "auto"
        ? { evidence: evidenceFor(mapping.checks, byKey) }
        : {}),
    };
  });
}

/** Tally buckets (+ live evidence when bound). Pure. */
export function summarizeStandard(entries: StandardEntry[]): StandardSummary {
  const summary: StandardSummary = { total: entries.length, auto: 0, gap: 0, manual: 0, na: 0 };
  for (const e of entries) summary[e.bucket]++;
  const bound = entries.filter((e) => e.bucket === "auto" && e.evidence);
  if (bound.length > 0) {
    summary.autoVerified = bound.filter((e) => e.evidence === "verified").length;
    summary.autoFailing = bound.filter((e) => e.evidence === "failing").length;
    summary.autoUnrun = bound.filter((e) => e.evidence === "unrun").length;
  }
  return summary;
}

/** The honest disclaimer — never says "compliant"/"certified". */
export function standardDisclaimer(descriptor: StandardDescriptor, summary: StandardSummary): string {
  let base =
    `Evidence map, not a compliance attestation: kit auto-verifies ${summary.auto} of the ` +
    `${summary.total} ${descriptor.label} (${descriptor.version}) ${descriptor.unit}s it maps ` +
    `(${summary.gap} gap, ${summary.manual} manual, ${summary.na} n/a). ` +
    `It does not assess the full standard and is not a substitute for a GRC tool.`;
  if (descriptor.caveat) base += ` ${descriptor.caveat}`;
  if (summary.autoVerified !== undefined) {
    base +=
      ` This run (--verify): ${summary.autoVerified} verified-passing, ${summary.autoFailing} FAILING, ` +
      `${summary.autoUnrun} not-run of the ${summary.auto} mapped AUTO ${descriptor.unit}s — mapped is not passing.`;
  }
  return base;
}

/** Build the full structured report. Pure + deterministic. */
export function buildStandardReport(
  descriptor: StandardDescriptor,
  results?: SecurityCheckResult[],
): StandardReport {
  const byKey = results ? indexResults(results) : undefined;
  const entries = buildStandardEntries(descriptor, byKey);
  const summary = summarizeStandard(entries);

  const order: string[] = [];
  const bySection = new Map<string, StandardEntry[]>();
  for (const e of entries) {
    const section = e.requirement.section;
    const bucket = bySection.get(section);
    if (bucket) bucket.push(e);
    else {
      order.push(section);
      bySection.set(section, [e]);
    }
  }

  return {
    key: descriptor.key,
    label: descriptor.label,
    version: descriptor.version,
    source: descriptor.source,
    sourceUrl: descriptor.sourceUrl,
    disclaimer: standardDisclaimer(descriptor, summary),
    summary,
    sections: order.map((section) => ({ section, entries: bySection.get(section)! })),
  };
}

const BUCKET_LABEL: Record<Bucket, string> = { auto: "AUTO", gap: "GAP", manual: "MANUAL", na: "N/A" };
const EVIDENCE_LABEL: Record<EvidenceState, string> = {
  verified: "verified",
  failing: "FAILING",
  unrun: "not-run",
};

/** Deterministic plain-text render, grouped by section. */
export function formatStandardText(
  report: StandardReport,
  color: (bucket: Bucket, label: string) => string = (_b, label) => label,
): string {
  const lines: string[] = [];
  lines.push(`kit coverage — ${report.label} ${report.version} (curated subset)`);
  lines.push(report.sourceUrl);
  lines.push("");
  lines.push(`! ${report.disclaimer}`);
  lines.push("");
  for (const { section, entries } of report.sections) {
    lines.push(section);
    for (const e of entries) {
      const label = color(e.bucket, BUCKET_LABEL[e.bucket].padEnd(6));
      lines.push(`  ${label} ${e.requirement.id.padEnd(12)} ${e.requirement.text}`);
      if (e.checks.length > 0) {
        const state = e.evidence ? `  [${EVIDENCE_LABEL[e.evidence]}]` : "";
        lines.push(`         evidence: ${e.checks.join(", ")}${state}`);
      }
      lines.push(`         ${e.rationale}`);
    }
    lines.push("");
  }
  const s = report.summary;
  lines.push(
    `Summary: ${s.auto} auto · ${s.gap} gap · ${s.manual} manual · ${s.na} n/a (of ${s.total} mapped controls)`,
  );
  if (s.autoVerified !== undefined) {
    lines.push(
      `Live (--verify): ${s.autoVerified} verified · ${s.autoFailing} FAILING · ${s.autoUnrun} not-run (of ${s.auto} auto)`,
    );
  }
  return lines.join("\n");
}
