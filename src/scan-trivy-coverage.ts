import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingestStrict } from "./adapters/ingest.js";
import { findIacFiles } from "./check-iac-detect.js";
import { scannerObject, scannerRecord } from "./check-scanner-evidence.js";
import type { SecurityCheckResult } from "./check-security.js";
import type { ScannerEvidence, ScannerProcess } from "./scan-result.js";
import { readTrivyReport, type TrivyFinding, type TrivyMode } from "./scan-trivy-report.js";

type Run = (args: string[], cwd: string, limitMs?: number) => Promise<ScannerProcess>;
type Report = ReturnType<typeof readTrivyReport>;

type Conversion = { process?: ScannerProcess; cleanupFailed?: true };

const minimumScores = { critical: 9, high: 7, medium: 4, low: 0 } as const;

function normalizeUri(uri: string): string {
  try {
    return decodeURI(uri).replaceAll("\\", "/");
  } catch {
    return uri;
  }
}

type FindingLocation = { target?: string; line?: number };

function sarifLocation(row: unknown): FindingLocation {
  if (!scannerRecord(row) || !Array.isArray(row.locations)) return {};
  const location = row.locations[0];
  if (!scannerRecord(location) || !scannerRecord(location.physicalLocation)) return {};
  const { artifactLocation: artifact, region } = location.physicalLocation;
  if (!scannerRecord(artifact) || typeof artifact.uri !== "string") return {};
  const line = scannerRecord(region) ? region.startLine : undefined;
  return { target: normalizeUri(artifact.uri), line: typeof line === "number" ? line : undefined };
}

function findingKey(name: string, label?: string, target?: string): string {
  return JSON.stringify([name, label, target]);
}

function resultLocations(runs: unknown[]): FindingLocation[] {
  return runs.flatMap((run) =>
    scannerRecord(run) && Array.isArray(run.results) ? run.results.map(sarifLocation) : [],
  );
}

function missingFindings(
  converted: SecurityCheckResult[],
  locations: FindingLocation[],
  native: TrivyFinding[],
): TrivyFinding[] {
  const slots = new Map<string, { score: number; line?: number }[]>();
  if (converted.length !== locations.length) return native;
  for (const [index, { name, detail, severity }] of converted.entries()) {
    const label = /^Package: [^\n]+\nInstalled Version: [^\n]+\n/.exec(detail)?.[0];
    const { target, line } = locations[index] ?? {};
    const key = findingKey(name, label, target);
    const scores = slots.get(key) ?? [];
    scores.push({ score: severity ? (minimumScores[severity] ?? -1) : -1, line });
    slots.set(key, scores);
  }
  return [...native]
    .sort((left, right) => Number(Boolean(right.line)) - Number(Boolean(left.line)))
    .filter(({ id, packageLabel, target, line, score, secret }) => {
      if (secret) return true;
      const scores = slots.get(findingKey("Trivy: " + id, packageLabel, target));
      const floor = Object.values(minimumScores).find((minimum) => Number(score) >= minimum) ?? 0;
      const match =
        scores
          ?.sort((left, right) => left.score - right.score)
          .findIndex(
            (candidate) =>
              candidate.score >= floor && (line === undefined || candidate.line === line),
          ) ?? -1;
      if (match < 0) return true;
      scores?.splice(match, 1);
      return false;
    });
}

function fallbackRun(findings: TrivyFinding[]) {
  return {
    tool: { driver: { name: "Trivy" } },
    results: findings.map(({ id, level, message, target, line, score }) => ({
      ruleId: id,
      level,
      message: { text: message },
      properties: { "security-severity": score },
      ...(target
        ? {
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: target },
                  ...(line ? { region: { startLine: line } } : {}),
                },
              },
            ],
          }
        : {}),
    })),
  };
}

function conversionEvidence(
  native: ScannerEvidence,
  cleanupFailed: boolean | undefined,
  complete: boolean,
): ScannerEvidence {
  if (cleanupFailed)
    return {
      status: "partial",
      reportGap: "partial",
      reason: "Trivy report workspace cleanup failed",
    };
  if (complete || native.status === "partial") return native;
  return {
    status: "partial",
    reportGap: "partial",
    reason: "Trivy SARIF conversion was incomplete",
  };
}

function recoverSarif(conversion: Conversion, report: Report) {
  const text = conversion.process?.stdout ?? "";
  const valid = ingestStrict("sarif", text);
  const parsed = valid.ok ? scannerObject(text) : undefined;
  const existing = Array.isArray(parsed?.runs) ? parsed.runs : [];
  const readable = valid.ok && !valid.coverage;
  const missing = missingFindings(
    readable ? valid.findings : [],
    resultLocations(existing),
    report.findings,
  );
  const complete = Boolean(
    conversion.process?.ok && readable && !missing.some((finding) => !finding.secret),
  );
  return {
    stdout:
      missing.length || !parsed
        ? JSON.stringify({ version: "2.1.0", runs: [...existing, fallbackRun(missing)] })
        : text,
    evidence: conversionEvidence(report.evidence, conversion.cleanupFailed, complete),
  };
}

function withoutSecretMatches(text: string): string {
  const report = scannerObject(text);
  if (!Array.isArray(report?.Results)) return text;
  let changed = false;
  for (const row of report.Results) {
    if (!scannerRecord(row) || !Object.hasOwn(row, "Secrets")) continue;
    delete row.Secrets;
    changed = true;
  }
  return changed ? JSON.stringify(report) : text;
}

function removeWorkspace(work: string): boolean {
  try {
    rmSync(work, { recursive: true, force: true, maxRetries: 3 });
    return true;
  } catch {
    return false;
  }
}

async function convertReport(text: string, cwd: string, run: Run): Promise<Conversion> {
  let work: string;
  try {
    work = mkdtempSync(join(tmpdir(), "kit-trivy-report-"));
  } catch {
    return {};
  }
  let result: ScannerProcess | undefined;
  try {
    const input = join(work, "report.json");
    writeFileSync(input, withoutSecretMatches(text), { flag: "wx", mode: 0o600 });
    result = await run(["convert", "--ignorefile", "", "--format", "sarif", input], cwd, 15_000);
  } catch {
    result = undefined;
  }
  const cleanupFailed = !removeWorkspace(work);
  return { process: result, ...(cleanupFailed ? { cleanupFailed: true } : {}) };
}

export async function runTrivyWithCoverage(
  cwd: string,
  args: string[],
  mode: TrivyMode,
  run: Run,
): Promise<ScannerProcess> {
  let root: string;
  try {
    root = realpathSync(cwd);
  } catch {
    return {
      ok: false,
      stdout: "",
      stderr: "Unable to prepare Trivy scan scope",
      noNumericExitStatus: true,
    };
  }
  const target = mode === "trivy-image" ? (args.at(-1) ?? "") : ".";
  const expectedConfig = mode === "trivy-config" ? await findIacFiles(root) : [];
  const process = await run(args, root);
  const report = readTrivyReport(process.stdout, mode, target, root, expectedConfig);
  const converted = report.convertible ? await convertReport(process.stdout, root, run) : {};
  return { ...process, ...recoverSarif(converted, report) };
}
