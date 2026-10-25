import type { SecurityCheckResult } from "./check-security.js";
import { scanTranscripts, type TranscriptHit } from "./scan-transcripts.js";

type Scan = (cwd: string) => Promise<TranscriptHit[]>;

/**
 * A credential in an agent transcript is replayed into every later prompt until the file is
 * purged, so it needs a rotation, not only a note. The result is a warning in the `secrets`
 * category: the findings tracker turns it into a ledger item without making the gate fail on a
 * machine whose history holds an old key. The detail carries labels and counts, never a value.
 */
export async function checkTranscriptSecrets(
  scan: Scan = scanTranscripts,
  cwd = process.cwd(),
): Promise<SecurityCheckResult> {
  const name = "agent transcripts";
  const category = "secrets" as const;
  let hits: TranscriptHit[];
  try {
    hits = await scan(cwd);
  } catch (e) {
    return {
      category,
      name,
      status: "warn",
      severity: "high",
      didNotRun: true,
      detail: `could not scan agent transcripts: ${(e as Error).message}`,
    };
  }
  if (hits.length === 0) {
    return { category, name, status: "pass", detail: "no credential in agent transcripts" };
  }
  const total = hits.reduce((sum, h) => sum + h.findings.length, 0);
  return {
    category,
    name,
    status: "warn",
    severity: "high",
    detail: `${total} potential secret(s) in ${hits.length} transcript/cache file(s)`,
    files: hits.map((h) => h.file),
    suggestion:
      "Rotate the leaked credential, then purge the file(s); `kit security scan-transcripts` lists them.",
  };
}
