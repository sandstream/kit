import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";

export const TRIAGE_LOG_FILE = ".kit-triage.jsonl";

/** A triage PASS counts as current for this long. Exported so every consumer reads ONE
 *  number: `check-deps` and `check-skills` gate new manifest entries on it, and the "install-script grants"
 *  security check asks the same freshness question about a package granted install scripts.
 *  Two copies of a policy window drift, and the drift is silent. */
export const TRIAGE_MAX_AGE_DAYS = 7;

const count = z.number().int().nonnegative();
export const skillScanEvidenceSchema = z.object({
  version: z.literal(1),
  source: z.literal("skillspector-static"),
  reportDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  runs: z
    .array(
      z.object({
        scannerVersion: z.string().min(1),
        coveragePercent: z.literal(100),
        fullyInspectedFiles: count.min(1),
        scopeExclusionCount: z.literal(0),
      }),
    )
    .length(1),
});
export type SkillScanEvidence = z.infer<typeof skillScanEvidenceSchema>;

export interface TriageLogEntry {
  timestamp: string;
  type: string;
  target: string;
  sandbox: boolean;
  deep?: boolean;
  granter: string;
  /** Exact npm spec evaluated by a kit-driven install, when more specific than target. */
  triagedSpec?: string;
  /** For a local skill: the digest of the files triaged (src/skill-triage-binding.ts). */
  contentDigest?: string;
  skillScan?: SkillScanEvidence;
}

export interface TriagePassInput {
  type: string;
  target: string;
  sandbox: boolean;
  deep?: boolean;
  cwd?: string;
  triagedSpec?: string;
  contentDigest?: string;
  skillScan?: SkillScanEvidence;
}

/** Append one PASS receipt. Callers decide whether a write failure blocks their operation. */
export async function appendTriagePass(input: TriagePassInput): Promise<void> {
  const entry: TriageLogEntry = {
    timestamp: new Date().toISOString(),
    type: input.type,
    target: input.target,
    sandbox: input.sandbox,
    deep: input.deep ?? false,
    granter: process.env.USER ?? "unknown",
    ...(input.triagedSpec ? { triagedSpec: input.triagedSpec } : {}),
    ...(input.contentDigest ? { contentDigest: input.contentDigest } : {}),
    ...(input.skillScan ? { skillScan: input.skillScan } : {}),
  };
  await appendFile(
    resolve(input.cwd ?? process.cwd(), TRIAGE_LOG_FILE),
    JSON.stringify(entry) + "\n",
    "utf-8",
  );
}
