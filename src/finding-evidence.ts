import { z } from "zod";
import { findSecretMatches, type SecretFinding, type SecretMatch } from "./utils/redactSecrets.js";

const sourceIdentity = {
  file: z
    .string()
    .min(1)
    .refine((value) => !value.includes("\0")),
  pattern: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,127}$/i),
};

export const findingEvidenceSchema = z.strictObject({
  ...sourceIdentity,
  line: z.number().int().positive(),
});

export const archiveEvidenceSchema = z.strictObject({
  ...sourceIdentity,
  byteOffset: z.number().int().nonnegative(),
});

export type ArchiveEvidence = z.infer<typeof archiveEvidenceSchema>;

export type FindingEvidence = z.infer<typeof findingEvidenceSchema>;

export const falsePositiveMarkSchema = z.strictObject({
  reason: z.string().trim().min(8),
});

export type EvidencedSecret = SecretFinding & { evidence: FindingEvidence };

export function formatEvidencedSecret({ evidence, preview }: EvidencedSecret): string {
  return `line ${evidence.line} ${evidence.pattern}:${preview}`;
}

export function locateSecretMatches(
  file: string,
  text: string,
  matches: readonly SecretMatch[] = findSecretMatches(text),
): EvidencedSecret[] {
  const ordered = [...matches].sort((a, b) => a.offset - b.offset);
  let line = 1;
  let next = text.indexOf("\n");
  return ordered.map(({ label, preview, offset }) => {
    while (next !== -1 && next < offset) {
      line++;
      next = text.indexOf("\n", next + 1);
    }
    return {
      label,
      preview,
      evidence: findingEvidenceSchema.parse({ file, line, pattern: label }),
    };
  });
}
