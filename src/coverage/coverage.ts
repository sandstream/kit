/**
 * kit coverage - maps kit's deterministic checks to the vendored OWASP ASVS L2
 * subset and buckets each control by how kit relates to it.
 *
 * This module is PURE (no IO, no network, no clock): given the static ASVS
 * subset and the static mapping below, it produces a deterministic report. That
 * makes it fixture-testable and means `kit coverage` says the same thing on
 * every machine, every run.
 *
 * Buckets:
 *   AUTO   - kit runs a deterministic check that produces evidence for this
 *            control. AUTO is NOT "compliant": kit verifies the specific,
 *            mechanical slice the check covers, which is usually narrower than
 *            the full normative requirement. The `rationale` says what slice.
 *   GAP    - squarely inside kit's deterministic, local, static scope, but kit
 *            has no check for it yet. An honest hole, surfaced on purpose.
 *   MANUAL - in scope conceptually but inherently needs a human (design review,
 *            privacy-law judgement, HSM attestation). kit cannot verify it.
 *   NA     - adjacent to kit but outside its reach (runtime/DAST/front-end), kept
 *            with an explicit reason so the boundary of kit's reach is visible.
 *
 * Evidence anchors reuse the citations co-located with the checks in
 * src/rules/catalog.ts (CWE / OWASP Top 10 / kit-native self-audit rules), so a
 * control's citations stay in lockstep with the checks that back it.
 */

import { ASVS_L2_SUBSET, ASVS_VERSION, ASVS_SOURCE, ASVS_SOURCE_URL } from "./asvs-l2.js";
import type { AsvsRequirement } from "./asvs-l2.js";
import { ruleForCheck, ruleForSelfAudit, type RuleRef } from "../rules/catalog.js";

export type Bucket = "auto" | "gap" | "manual" | "na";

/** One row of the static control -> kit relationship mapping. */
interface MappingEntry {
  bucket: Bucket;
  /**
   * kit evidence ids that back this control: security-check names (see
   * check-security.ts), self-audit rule ids (R1..R12), scanner names, or kit
   * command names. Empty for MANUAL / NA (kit produces no deterministic evidence).
   */
  checks: string[];
  /** Honest, specific reason for the bucket - what kit does or does not verify. */
  rationale: string;
}

/**
 * Static mapping keyed by ASVS id. Every id in ASVS_L2_SUBSET must appear here
 * exactly once and every key here must be a real subset id - both directions are
 * enforced by coverage.test.ts so the map cannot rot.
 */
const MAPPING: Record<string, MappingEntry> = {
  "V1.1.2": {
    bucket: "manual",
    checks: [],
    rationale:
      "Threat modeling is a human design activity; kit runs no deterministic check that can observe whether it happened.",
  },
  "V2.10.4": {
    bucket: "auto",
    checks: [
      "secrets scan",
      ".env gitignored",
      "scan-staged",
      "scan-build",
      "agent-audit",
      "R2-secret-argv",
    ],
    rationale:
      "kit scans source, staged diffs, build artifacts, and agent/MCP configs for hard-coded credentials and ensures .env is gitignored.",
  },
  "V6.4.1": {
    bucket: "auto",
    checks: ["secrets", "secrets validate", "agent-audit"],
    rationale:
      "kit resolves secrets from a vault rather than plaintext .env and flags plaintext secrets in configs; it does not audit the vault's own access controls.",
  },
  "V6.4.2": {
    bucket: "manual",
    checks: [],
    rationale:
      "Whether key material stays inside an isolated security module (HSM/KMS) is an infrastructure attestation kit cannot observe locally.",
  },
  "V7.1.1": {
    bucket: "auto",
    checks: ["scan-transcripts", "R2-secret-argv"],
    rationale:
      "kit scans agent transcripts and prompt caches for leaked credentials and self-audits that secrets are never interpolated into error/log output.",
  },
  "V7.1.2": {
    bucket: "manual",
    checks: [],
    rationale:
      "Whether a value counts as privacy-sensitive under applicable law is a human judgement; kit cannot classify domain data deterministically.",
  },
  "V7.3.1": {
    bucket: "gap",
    checks: [],
    rationale:
      "Log-injection encoding in the target app is statically checkable in principle, but kit has no check for it yet (kit only self-audits its own output escaping via R7).",
  },
  "V10.3.2": {
    bucket: "auto",
    checks: [
      "pinned versions",
      "package-lock.json",
      "supply-chain",
      "socket scan",
      "guarddog (malware)",
      "R6-dynamic-import",
    ],
    rationale:
      "kit verifies pinned versions and a committed lockfile, triages install scripts / dep-confusion / slopsquat, and scans dependencies for malware.",
  },
  "V14.1.1": {
    bucket: "auto",
    checks: ["gha-audit"],
    rationale:
      "Partial: kit lints CI workflows for unpinned actions and pwn-request patterns. It does not verify build reproducibility, so this slice is narrower than the full control.",
  },
  "V14.1.5": {
    bucket: "gap",
    checks: [],
    rationale:
      "kit makes its OWN audit log tamper-evident (HMAC anchor, R9) but has no check that verifies the integrity of the target project's security-relevant configuration.",
  },
  "V14.2.1": {
    bucket: "auto",
    checks: ["npm audit", "pip-audit", "trivy container scan", "trivy fs (jvm)", "scan", "sbom"],
    rationale:
      "kit runs dependency checkers (npm/pip audit, trivy) and merges external scanners (osv/snyk/grype) into one verdict; it can emit an SBOM of the resolved tree.",
  },
  "V14.2.4": {
    bucket: "auto",
    checks: ["supply-chain", "socket scan", "guarddog (malware)", "security policy"],
    rationale:
      "kit detects dependency-confusion and typosquat (slopsquat) candidates and can enforce a dependency allowlist of trusted sources.",
  },
  "V14.4.1": {
    bucket: "na",
    checks: [],
    rationale:
      "Inspecting live HTTP response headers needs a running app (DAST); kit is a local, static, zero-egress tool and does not make requests.",
  },
  "V8.2.2": {
    bucket: "na",
    checks: [],
    rationale:
      "What a page writes to browser storage is a client-runtime behaviour; kit performs no runtime/front-end execution analysis.",
  },
};

export interface CoverageEntry {
  requirement: AsvsRequirement;
  bucket: Bucket;
  /** kit evidence ids backing the control (see MappingEntry.checks). */
  checks: string[];
  /** Honest reason for the bucket. */
  rationale: string;
  /** Citations resolved from src/rules/catalog.ts for the backing checks, deduped. */
  citations: RuleRef[];
}

export interface CoverageSummary {
  total: number;
  auto: number;
  gap: number;
  manual: number;
  na: number;
}

export interface CoverageReport {
  asvsVersion: string;
  source: string;
  sourceUrl: string;
  /** Loud one-line honesty disclaimer; never claims compliance/certification. */
  disclaimer: string;
  summary: CoverageSummary;
  sections: { section: string; entries: CoverageEntry[] }[];
}

/** Resolve catalog citations for a set of check ids, deduped by citation id. */
function citationsFor(checks: string[]): RuleRef[] {
  const out: RuleRef[] = [];
  const seen = new Set<string>();
  for (const id of checks) {
    const ref = ruleForCheck(id) ?? ruleForSelfAudit(id);
    if (ref && !seen.has(ref.id)) {
      seen.add(ref.id);
      out.push(ref);
    }
  }
  return out;
}

/**
 * Build the flat list of coverage entries, in ASVS_L2_SUBSET order. Throws if a
 * subset control has no mapping - a loud failure beats silently dropping a
 * control from the evidence map.
 */
export function buildCoverageEntries(): CoverageEntry[] {
  return ASVS_L2_SUBSET.map((requirement) => {
    const mapping = MAPPING[requirement.id];
    if (!mapping) {
      throw new Error(`coverage: ASVS ${requirement.id} is in the subset but has no mapping`);
    }
    return {
      requirement,
      bucket: mapping.bucket,
      checks: [...mapping.checks],
      rationale: mapping.rationale,
      citations: citationsFor(mapping.checks),
    };
  });
}

/** Tally buckets across a list of entries. Pure. */
export function summarize(entries: CoverageEntry[]): CoverageSummary {
  const summary: CoverageSummary = { total: entries.length, auto: 0, gap: 0, manual: 0, na: 0 };
  for (const e of entries) summary[e.bucket]++;
  return summary;
}

/**
 * The loud honesty disclaimer. Deliberately avoids the words "compliant" and
 * "certified": kit maps evidence, it does not attest to compliance. This string
 * is asserted in tests to keep the brand promise (green = honest) enforced.
 */
export function honestyDisclaimer(summary: CoverageSummary): string {
  return (
    `Evidence map, not a compliance attestation: kit auto-verifies ${summary.auto} of the ` +
    `${summary.total} OWASP ASVS ${ASVS_VERSION} L2 controls it maps ` +
    `(${summary.gap} gap, ${summary.manual} manual, ${summary.na} n/a). ` +
    `It does not assess the full standard and is not a substitute for a GRC tool ` +
    `(e.g. Vanta, Drata) - feed this evidence to one.`
  );
}

/** Build the full structured report (the --json payload). Pure + deterministic. */
export function buildCoverageReport(): CoverageReport {
  const entries = buildCoverageEntries();
  const summary = summarize(entries);

  // Group by section, preserving first-seen section order from the subset.
  const order: string[] = [];
  const bySection = new Map<string, CoverageEntry[]>();
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
    asvsVersion: ASVS_VERSION,
    source: ASVS_SOURCE,
    sourceUrl: ASVS_SOURCE_URL,
    disclaimer: honestyDisclaimer(summary),
    summary,
    sections: order.map((section) => ({ section, entries: bySection.get(section)! })),
  };
}

const BUCKET_LABEL: Record<Bucket, string> = {
  auto: "AUTO",
  gap: "GAP",
  manual: "MANUAL",
  na: "N/A",
};

/**
 * Render the report as a deterministic plain-text table grouped by ASVS section.
 * `color` wraps a bucket label for the terminal; default is identity so the
 * output is plain (and test-comparable) unless a colorizer is supplied.
 */
export function formatCoverageText(
  report: CoverageReport,
  color: (bucket: Bucket, label: string) => string = (_b, label) => label,
): string {
  const lines: string[] = [];
  lines.push(`kit coverage - OWASP ASVS ${report.asvsVersion} L2 (curated subset)`);
  lines.push(report.sourceUrl);
  lines.push("");
  lines.push(`! ${report.disclaimer}`);
  lines.push("");

  for (const { section, entries } of report.sections) {
    lines.push(section);
    for (const e of entries) {
      const label = color(e.bucket, BUCKET_LABEL[e.bucket].padEnd(6));
      lines.push(`  ${label} ${e.requirement.id.padEnd(9)} ${e.requirement.text}`);
      if (e.checks.length > 0) {
        lines.push(`         evidence: ${e.checks.join(", ")}`);
      }
      lines.push(`         ${e.rationale}`);
    }
    lines.push("");
  }

  const s = report.summary;
  lines.push(
    `Summary: ${s.auto} auto · ${s.gap} gap · ${s.manual} manual · ${s.na} n/a (of ${s.total} mapped controls)`,
  );
  return lines.join("\n");
}
