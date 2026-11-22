import { z } from "zod";
import { createHash } from "node:crypto";
import { ingestSarifReport } from "./adapters/ingest.js";
import type { SecurityCheckResult } from "./check-security.js";
import type { SkillScanEvidence } from "./triage-receipt.js";

export const SKILLSPECTOR_SOURCE = "SkillSpector (NVIDIA) Stage 1";

const count = z.number().int().nonnegative();
const completeness = z.object({
  status: z.enum(["complete", "complete_with_caveats", "partial", "failed"]),
  isComplete: z.boolean(),
  coveragePercent: z.number().min(0).max(100),
  fullyInspectedFiles: count,
  partiallyInspectedFiles: count,
  entirelyUninspectedFiles: count,
  ledgerExceptionCount: count,
  scopeExclusionCount: count,
  excludedFileCount: count.optional(),
  assessmentComplete: z.boolean().optional(),
  limitationCount: count,
  notificationsTruncated: z.boolean(),
});
const invocation = z.object({
  executionSuccessful: z.boolean(),
  properties: z.object({ analysisCompleteness: completeness.optional() }).optional(),
});
const result = z.object({
  ruleId: z.string().min(1),
  message: z.object({ text: z.string() }),
  level: z.enum(["error", "warning", "note", "none"]),
  properties: z
    .object({
      "security-severity": z
        .string()
        .regex(/^(?:[0-9](?:\.\d+)?|10(?:\.0+)?)$/)
        .optional(),
    })
    .optional(),
});
const run = z.object({
  tool: z.object({ driver: z.object({ name: z.string(), version: z.string().min(1).optional() }) }),
  results: z.array(result).optional(),
  invocations: z.array(invocation).optional(),
});
const envelope = z.object({ version: z.string().optional(), runs: z.array(run) });

export type SkillspectorReport =
  | { status: "ok"; findings: SecurityCheckResult[]; evidence: SkillScanEvidence }
  | {
      status: "malformed" | "missing" | "unsupported" | "partial" | "caveats";
      detail: string;
      findings: SecurityCheckResult[];
    };

function normalizeFindings(findings: SecurityCheckResult[]): SecurityCheckResult[] {
  return findings.map((finding) => ({
    ...finding,
    category: "supply-chain",
    name: `${SKILLSPECTOR_SOURCE}: ${finding.name.replace(/^[^:]+:\s*/, "")}`,
  }));
}

function complete(coverage: z.infer<typeof completeness>): boolean {
  return (
    coverage.status === "complete" &&
    coverage.isComplete &&
    coverage.assessmentComplete !== false &&
    coverage.coveragePercent === 100 &&
    coverage.fullyInspectedFiles > 0 &&
    coverage.partiallyInspectedFiles === 0 &&
    coverage.entirelyUninspectedFiles === 0 &&
    coverage.ledgerExceptionCount === 0 &&
    coverage.limitationCount === 0 &&
    !coverage.notificationsTruncated
  );
}

type RunCoverage =
  | { ok: true; coverage: SkillScanEvidence["runs"][number] }
  | { ok: false; status: "missing" | "unsupported" | "partial" | "caveats"; detail: string };

function assessRun(scan: z.infer<typeof run>): RunCoverage {
  if (!scan.results)
    return { ok: false, status: "missing", detail: "The SkillSpector run has no results array." };
  if (scan.invocations?.length !== 1 || !scan.tool.driver.version)
    return {
      ok: false,
      status: "unsupported",
      detail: "Expected a SkillSpector version and one reported invocation.",
    };
  const [invocation] = scan.invocations;
  if (!invocation.executionSuccessful)
    return {
      ok: false,
      status: "partial",
      detail: "SkillSpector reports that execution did not finish.",
    };
  const coverage = invocation.properties?.analysisCompleteness;
  if (!coverage)
    return {
      ok: false,
      status: "unsupported",
      detail: "This SkillSpector report lacks coverage evidence.",
    };
  if (coverage.status === "complete_with_caveats" && coverage.isComplete)
    return {
      ok: false,
      status: "caveats",
      detail: "SkillSpector reports a complete scan with caveats.",
    };
  const excluded = Math.max(coverage.scopeExclusionCount, coverage.excludedFileCount ?? 0);
  if (excluded > 0)
    return {
      ok: false,
      status: "partial",
      detail: `SkillSpector excluded ${excluded} items from its scan scope.`,
    };
  if (!complete(coverage))
    return {
      ok: false,
      status: "partial",
      detail: `SkillSpector reports incomplete analysis with ${coverage.coveragePercent}% coverage.`,
    };
  return {
    ok: true,
    coverage: {
      scannerVersion: scan.tool.driver.version,
      coveragePercent: 100,
      fullyInspectedFiles: coverage.fullyInspectedFiles,
      scopeExclusionCount: 0,
    },
  };
}

export function readSkillspectorReport(stdout: string): SkillspectorReport {
  if (!stdout.trim())
    return { status: "missing", detail: "SkillSpector returned no report.", findings: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { status: "malformed", detail: "SkillSpector output is not valid JSON.", findings: [] };
  }

  const report = envelope.safeParse(parsed);
  if (!report.success) {
    return {
      status: "malformed",
      detail: "SkillSpector returned an invalid SARIF report.",
      findings: [],
    };
  }
  const { version, runs } = report.data;
  if (
    version !== "2.1.0" ||
    runs.some((scan) => scan.tool.driver.name.toLowerCase() !== "skillspector")
  ) {
    return {
      status: "unsupported",
      detail: "Expected SARIF 2.1.0 from SkillSpector.",
      findings: [],
    };
  }
  if (!runs.length)
    return { status: "missing", detail: "The SkillSpector report contains no runs.", findings: [] };
  if (runs.length !== 1)
    return {
      status: "unsupported",
      detail: "Expected one SkillSpector run for one skill.",
      findings: [],
    };
  const ingested = ingestSarifReport(parsed);
  const findings = ingested.ok ? normalizeFindings(ingested.findings) : [];
  const result = assessRun(runs[0]);
  if (!result.ok) return { status: result.status, detail: result.detail, findings };
  if (!ingested.ok)
    return { status: ingested.reportGap ?? "malformed", detail: ingested.reason, findings };
  if (ingested.coverage === "partial")
    return {
      status: "partial",
      detail: ingested.notes?.join(" ") ?? "SARIF is partial.",
      findings,
    };
  return {
    status: "ok",
    findings,
    evidence: {
      version: 1,
      source: "skillspector-static",
      reportDigest: "sha256:" + createHash("sha256").update(stdout).digest("hex"),
      runs: [result.coverage],
    },
  };
}
