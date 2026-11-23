import type { SecurityCheckResult } from "./check-security.js";
import { sanitizeDisplayText } from "./display-text.js";
import { scanTranscripts, transcriptCoverageDetail } from "./scan-transcripts.js";

type Scan = typeof scanTranscripts;
const check = { name: "agent transcripts", category: "secrets" } as const;

/** Keep the finding and scope outcomes independent so gaps never erase finding evidence. */
export async function checkTranscriptSecrets(
  scan: Scan = scanTranscripts,
  cwd = process.cwd(),
): Promise<SecurityCheckResult> {
  try {
    return transcriptCheck(await scan(cwd));
  } catch {
    return {
      ...check,
      status: "warn",
      severity: "high",
      didNotRun: true,
      evidenceStatus: "unavailable",
      detail: "Could not scan agent transcripts",
    };
  }
}

function transcriptCheck(scan: Awaited<ReturnType<Scan>>): SecurityCheckResult {
  const { hits, evidenceStatus } = scan;
  const row = { ...check, evidenceStatus };
  if (evidenceStatus === "missing")
    return { ...row, status: "skip", detail: "No supported agent transcript directories" };

  const coverage = transcriptCoverageDetail(scan);
  if (evidenceStatus === "complete-empty")
    return { ...row, status: "pass", detail: `No credentials found. ${coverage}` };

  const gap =
    evidenceStatus === "complete" ? {} : { didNotRun: true, scanIncomplete: true as const };
  if (hits.length === 0)
    return { ...row, ...gap, status: "warn", severity: "medium", detail: coverage };

  const total = hits.reduce((sum, hit) => sum + hit.findings.length, 0);
  return {
    ...row,
    ...gap,
    status: "warn",
    severity: "high",
    hasFindings: true,
    detail: `${total} potential secret(s) in ${hits.length} transcript/cache file(s). ${coverage}`,
    files: hits.map((hit) => sanitizeDisplayText(hit.file)),
    suggestion:
      "Rotate the leaked credential, then purge the files. Run `kit security scan-transcripts`.",
  };
}
